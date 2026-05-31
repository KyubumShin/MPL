/**
 * MPL v2 L2 — bounded re-entry policy (Move #17).
 *
 * Bucket X (semantic divergence) triggers ONE bounded re-entry per
 * (wave_id, contract_ref) tuple. Persistence lives in
 *   state.reconciler_reentries = {
 *     [wave_id]: {
 *       [contract_ref_hash]: { count<=1, winner_phase_id, loser_phase_id }
 *     }
 *   }
 *
 * The merge policy for this new top-level state field is `phase_keyed`
 * via the wave_id segment (mpl.config.yaml `state.merge_policy.
 * reconciler_reentries`).
 */

import { createHash } from 'crypto';

export const REENTRY_CAP = 1;

export function contractRefHash(contractRef) {
  if (!contractRef) return null;
  if (typeof contractRef === 'string') return createHash('sha256').update(contractRef).digest('hex').slice(0, 16);
  const canonical = `${contractRef.contract_id || ''}:${contractRef.clause || ''}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Decide whether a semantic-divergence (bucket X) finding may trigger a
 * re-entry. Returns one of:
 *   { allowed: true, winner_phase_id, loser_phase_id, contract_ref_hash, count: 1 }
 *   { allowed: false, reason: 'reentry_exhausted',
 *     prior_count, contract_ref_hash, failure_code: 'semantic_reentry_exhausted' }
 *
 * `state` is the LATEST `.mpl/state.json` snapshot. `finding` is a single
 * X-bucket entry from manifest-diff.mjs.
 *
 * Winner = lowest decomposition_rank phase per the move spec.
 */
export function decideReentry({ state, waveId, finding, manifests }) {
  const contract_ref_hash = contractRefHash(finding.contract_ref);
  const prior = state?.reconciler_reentries?.[waveId]?.[contract_ref_hash];
  const priorCount = typeof prior?.count === 'number' ? prior.count : 0;
  if (priorCount >= REENTRY_CAP) {
    return {
      allowed: false,
      reason: 'reentry_exhausted',
      prior_count: priorCount,
      contract_ref_hash,
      wave_id: waveId,
      failure_code: 'semantic_reentry_exhausted',
    };
  }

  // Winner = lowest decomposition_rank (ties broken by phase_id lex).
  const ranks = new Map();
  for (const m of (manifests || [])) {
    if (m && typeof m.phase_id === 'string') {
      ranks.set(m.phase_id, Number.isFinite(m.decomposition_rank) ? m.decomposition_rank : Number.MAX_SAFE_INTEGER);
    }
  }
  const pair = [finding.phase_a, finding.phase_b].sort((x, y) => {
    const rx = ranks.get(x) ?? Number.MAX_SAFE_INTEGER;
    const ry = ranks.get(y) ?? Number.MAX_SAFE_INTEGER;
    if (rx !== ry) return rx - ry;
    return x < y ? -1 : 1;
  });
  const [winner, loser] = pair;
  return {
    allowed: true,
    winner_phase_id: winner,
    loser_phase_id: loser,
    contract_ref_hash,
    wave_id: waveId,
    count: priorCount + 1,
  };
}

/**
 * Project a re-entry decision into a state patch for the
 * `reconciler_reentries` subtree. Returned object is shaped for
 * writeState patch consumption.
 */
export function reentryStatePatch(decision) {
  if (!decision || !decision.allowed) return null;
  return {
    reconciler_reentries: {
      [decision.wave_id]: {
        [decision.contract_ref_hash]: {
          count: decision.count,
          winner_phase_id: decision.winner_phase_id,
          loser_phase_id: decision.loser_phase_id,
        },
      },
    },
  };
}
