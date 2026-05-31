/**
 * MPL v2 L2 — reconciler verdict validator (Move #17).
 *
 * Validates the JSON written by mpl-adversarial-reviewer --mode=reconcile
 * (Step R4 in the reconcile branch) at:
 *   .mpl/signals/reconcile/wave-<tier>-<wave>-reconciler-verdict.json
 *
 * Required shape:
 *   {
 *     wave_id: string,
 *     phase_pair: [string, string],
 *     decision: 'accept_producer' | 'accept_consumer'
 *               | 'reconcile_required' | 'reject_both',
 *     rationale: string,
 *     evidence_refs: [
 *       {kind:'file', path, line, hash} |
 *       {kind:'contract', contract_id, clause} |
 *       {kind:'symbol', name, signature_hash}
 *     ],
 *     fix_patch_path?: string,
 *     produced_at: ISO
 *   }
 *
 * `evidence_refs[]` is REQUIRED non-empty when decision != 'reject_both'.
 * Bare "the producer is right" verdicts that lack file:line / contract
 * clause / signature_hash anchors are rejected — exactly the
 * generic-feedback failure mode the agent prompt calls out.
 */

const VALID_DECISIONS = new Set([
  'accept_producer',
  'accept_consumer',
  'reconcile_required',
  'reject_both',
]);

const EVIDENCE_KIND_SHAPES = {
  file: ['path', 'line'],
  contract: ['contract_id'],
  symbol: ['name'],
};

function isIsoTimestamp(s) {
  if (typeof s !== 'string') return false;
  // Simple ISO-8601 sanity check; full RFC 3339 in production callers.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s);
}

/**
 * Validate a verdict object. Returns { valid: boolean, errors: [...] }.
 * Never throws — callers branch on `.valid`.
 */
export function validateReconcilerVerdict(verdict) {
  const errors = [];
  if (!verdict || typeof verdict !== 'object') {
    return { valid: false, errors: ['verdict must be an object'] };
  }

  if (typeof verdict.wave_id !== 'string' || !verdict.wave_id) {
    errors.push("wave_id: string required");
  }

  if (!Array.isArray(verdict.phase_pair) || verdict.phase_pair.length !== 2
      || typeof verdict.phase_pair[0] !== 'string'
      || typeof verdict.phase_pair[1] !== 'string') {
    errors.push("phase_pair: [string, string] required");
  }

  if (!VALID_DECISIONS.has(verdict.decision)) {
    errors.push(`decision: must be one of ${[...VALID_DECISIONS].join('|')}`);
  }

  if (typeof verdict.rationale !== 'string' || !verdict.rationale.trim()) {
    errors.push("rationale: non-empty string required");
  }

  const refs = verdict.evidence_refs;
  if (!Array.isArray(refs)) {
    errors.push("evidence_refs: array required");
  } else if (verdict.decision && verdict.decision !== 'reject_both' && refs.length === 0) {
    errors.push("evidence_refs: at least one anchor required when decision != 'reject_both' (file:line / contract clause / signature_hash)");
  } else {
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      if (!r || typeof r !== 'object') {
        errors.push(`evidence_refs[${i}]: must be an object`);
        continue;
      }
      const need = EVIDENCE_KIND_SHAPES[r.kind];
      if (!need) {
        errors.push(`evidence_refs[${i}].kind '${r.kind}' invalid (file|contract|symbol)`);
        continue;
      }
      for (const k of need) {
        if (r[k] === undefined || r[k] === null || r[k] === '') {
          errors.push(`evidence_refs[${i}] (${r.kind}): field '${k}' required`);
        }
      }
    }
  }

  if (verdict.fix_patch_path !== undefined && typeof verdict.fix_patch_path !== 'string') {
    errors.push("fix_patch_path: string when present");
  }

  if (!isIsoTimestamp(verdict.produced_at)) {
    errors.push("produced_at: ISO-8601 timestamp required");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Path the verdict file is expected to live at given a wave_id.
 * Mirrors the engine's mpl-require-reconciliation.mjs gate expectations.
 */
export function verdictPathForWave(cwd, waveId) {
  // waveId = `${tier}:${wave_index}`; on-disk uses `wave-<tier>-<wave_index>`.
  const safe = String(waveId || '').replace(':', '-');
  return `${cwd}/.mpl/signals/reconcile/wave-${safe}-reconciler-verdict.json`;
}
