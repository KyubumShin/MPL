/**
 * MPL v2 L2 — reconcile policy module entrypoint (Move #17).
 *
 * `reconcileWave(waveId, cwd) -> verdict` orchestrates the deterministic
 * 4-bucket classifier (manifest-diff.mjs) + bounded re-entry (reentry-
 * policy.mjs) + reconciler verdict validator (reconciler-verdict-
 * validator.mjs).
 *
 * STATUS — ADDITIVE / DORMANT
 *   This module is importable + unit-tested but is NOT yet on the engine
 *   dispatch path. A follow-on move adds the `wave_end` route + the
 *   `mpl-require-reconciliation.mjs` gate that calls into here.
 *
 * Outputs (written deterministically by index.mjs#reconcileWave):
 *   - .mpl/signals/reconcile/wave-reconciliation.json   ALWAYS
 *     Schema: { wave_id, classified_at, buckets:{T:[],S:[],C:[],X:[]},
 *               outcome:'clean'|'reconciled'|'aborted'|'pending_verifier',
 *               failure_code?:<canonical>,
 *               reconciler_reentries:{[phase_id]:int} }
 *
 *   - .mpl/signals/reconcile/wave-<tier>-<wave>-reconciler-verdict.json
 *     ONLY when bucket C non-empty AND the verifier dispatch completed
 *     (caller observes the file appearing; reconcileWave NEVER writes it
 *     itself — that's the reviewer's contract).
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

import {
  BUCKETS,
  RECONCILE_FAILURE_CODES,
  classifyPair,
  classifyWave,
} from './manifest-diff.mjs';
import {
  decideReentry,
  reentryStatePatch,
  contractRefHash,
  REENTRY_CAP,
} from './reentry-policy.mjs';
import {
  validateReconcilerVerdict,
  verdictPathForWave,
} from './reconciler-verdict-validator.mjs';

export {
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
};

/**
 * Outcome enum surfaced in wave-reconciliation.json.
 */
export const RECONCILE_OUTCOMES = Object.freeze({
  CLEAN: 'clean',
  RECONCILED: 'reconciled',
  ABORTED: 'aborted',
  PENDING_VERIFIER: 'pending_verifier',
});

const SIGNAL_DIR = join('.mpl', 'signals', 'reconcile');

function readPhaseManifest(cwd, phaseId) {
  const path = join(cwd, '.mpl', 'mpl', 'phases', phaseId, 'phase-manifest.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function writeReconciliationVerdict(cwd, payload) {
  const dir = join(cwd, SIGNAL_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = join(dir, 'wave-reconciliation.json');
  writeFileSync(out, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return out;
}

function readReconcilerVerdict(cwd, waveId) {
  const path = verdictPathForWave(cwd, waveId);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

/**
 * Top-level reconcile entrypoint.
 *
 * @param {string} waveId  `${tier}:${wave_index}`
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string[]} [opts.phase_ids]  IDs to read manifests for. When
 *                                     omitted, the caller is expected to
 *                                     provide opts.manifests directly.
 * @param {object[]} [opts.manifests]  Pre-loaded manifest objects.
 * @param {object} [opts.state]        Latest .mpl/state.json snapshot (for
 *                                     reentry-policy persistence checks).
 * @param {(p:string,a:string,b:string)=>boolean} [opts.coEditPermitted]
 *                                     Cross-phase co-edit permit lookup
 *                                     (from decomposition.yaml). Default:
 *                                     never permitted.
 * @returns {{
 *   wave_id, classified_at, buckets, outcome, failure_code?, reconciler_reentries,
 *   state_patches?: object[],
 *   verdict_path?: string,
 * }}
 */
export function reconcileWave(waveId, cwd, opts = {}) {
  const manifests = (opts.manifests && Array.isArray(opts.manifests))
    ? opts.manifests
    : (Array.isArray(opts.phase_ids) ? opts.phase_ids.map((pid) => readPhaseManifest(cwd, pid)).filter(Boolean) : []);
  const state = opts.state ?? null;
  const coEditPermitted = typeof opts.coEditPermitted === 'function' ? opts.coEditPermitted : () => false;

  const buckets = classifyWave(manifests, { coEditPermitted });
  const reentryCounts = {}; // {phase_id: int}

  let outcome = RECONCILE_OUTCOMES.CLEAN;
  let failure_code;
  const state_patches = [];

  // T → ABORT.
  if (buckets.T.length > 0) {
    outcome = RECONCILE_OUTCOMES.ABORTED;
    failure_code = RECONCILE_FAILURE_CODES.TEXTUAL_CONFLICT;
  } else {
    // S idempotent already resolved by manifest-diff (resolution:'idempotent'
    // is just informational here — the merge happens in wave-reducer).
    // S with escalate_to: 'C' was promoted into C.

    if (buckets.X.length > 0) {
      for (const finding of buckets.X) {
        const decision = decideReentry({ state, waveId, finding, manifests });
        if (!decision.allowed) {
          outcome = RECONCILE_OUTCOMES.ABORTED;
          failure_code = decision.failure_code;
          break;
        } else {
          const patch = reentryStatePatch(decision);
          if (patch) state_patches.push(patch);
          reentryCounts[decision.loser_phase_id] = (reentryCounts[decision.loser_phase_id] || 0) + 1;
          // X-only resolved by bounded re-entry → reconciled.
          if (outcome === RECONCILE_OUTCOMES.CLEAN) outcome = RECONCILE_OUTCOMES.RECONCILED;
        }
      }
    }

    if (failure_code === undefined && buckets.C.length > 0) {
      // C requires verifier dispatch; check whether the reviewer already
      // wrote a verdict.json. If yes → reconciled; if no → pending_verifier.
      const verdict = readReconcilerVerdict(cwd, waveId);
      if (verdict) {
        const v = validateReconcilerVerdict(verdict);
        if (!v.valid) {
          outcome = RECONCILE_OUTCOMES.ABORTED;
          failure_code = RECONCILE_FAILURE_CODES.CONTRACT_RECONCILE_REQUIRED;
        } else if (verdict.decision === 'reject_both') {
          outcome = RECONCILE_OUTCOMES.ABORTED;
          failure_code = RECONCILE_FAILURE_CODES.CONTRACT_RECONCILE_REQUIRED;
        } else {
          outcome = RECONCILE_OUTCOMES.RECONCILED;
        }
      } else {
        outcome = RECONCILE_OUTCOMES.PENDING_VERIFIER;
      }
    }

    if (failure_code === undefined && buckets.S.length > 0 && outcome === RECONCILE_OUTCOMES.CLEAN) {
      // S findings present but all idempotent: still clean (the reducer
      // will deterministically pick the winner).
      outcome = RECONCILE_OUTCOMES.CLEAN;
    }
  }

  const payload = {
    wave_id: waveId,
    classified_at: new Date().toISOString(),
    buckets,
    outcome,
    reconciler_reentries: reentryCounts,
  };
  if (failure_code) payload.failure_code = failure_code;

  const out = writeReconciliationVerdict(cwd, payload);
  return { ...payload, state_patches, verdict_path: out };
}
