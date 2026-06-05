/**
 * exp25 R04 (part b) — phase-runner receipt handoff (thin-harness GJC pattern).
 *
 * A phase-runner currently returns a verbose JSON blob (including the full
 * state_summary markdown) to the orchestrator, bloating its context. The GJC
 * "receipt" handoff replaces that with a COMPACT, verifiable record: a verdict
 * enum + a sha256 over the on-disk artifacts + counts + disk pointers. The
 * orchestrator reads the receipt and only opens the full state-summary.md when it
 * needs detail — context savings + a tamper-evident audit trail.
 *
 * This module is pure-ish: validateReceipt / parseReceipt / buildReceiptRecord
 * are pure; sha256OfFiles does bounded fs reads. The recorder (policy/schemas.mjs
 * handlePhaseReceipt) wires it on PostToolUse Task/Agent.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

export const VALID_VERDICTS = Object.freeze(['PASS', 'FAIL', 'PARTIAL', 'CIRCUIT_BREAK', 'BLOCKED']);

/** Subagent types whose returns carry a phase receipt. */
export const RECEIPT_AGENTS = Object.freeze(new Set(['mpl-phase-runner']));

const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * PURE. Validate a receipt object.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateReceipt(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { valid: false, errors: ['receipt_absent'] };
  const errors = [];
  if (typeof r.phase_id !== 'string' || !r.phase_id.trim()) errors.push('phase_id_missing');
  if (!VALID_VERDICTS.includes(r.verdict)) errors.push('verdict_invalid');
  if (typeof r.artifacts_sha256 !== 'string' || !SHA256_RE.test(r.artifacts_sha256)) errors.push('artifacts_sha256_invalid');
  return { valid: errors.length === 0, errors };
}

/**
 * PURE. Extract the `receipt` object from a phase-runner's return text. The
 * return is a ```json fenced object that contains a top-level `receipt` key (or
 * is itself the receipt). Returns the receipt object, or null if none found.
 */
export function parseReceipt(text) {
  if (typeof text !== 'string' || !text) return null;
  const candidates = [];
  // 1) fenced ```json ... ``` blocks
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text)) !== null) candidates.push(m[1]);
  // 2) the whole text, as a fallback (already-unwrapped JSON)
  candidates.push(text);
  for (const c of candidates) {
    const trimmed = c.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj && typeof obj === 'object') {
      if (obj.receipt && typeof obj.receipt === 'object') return obj.receipt;
      // the object itself looks like a receipt
      if (typeof obj.verdict === 'string' && typeof obj.artifacts_sha256 === 'string') return obj;
    }
  }
  return null;
}

/**
 * sha256 over the listed artifact files, as a PLAIN byte concatenation in order —
 * i.e. identical to `cat <files> | shasum -a 256`, so the phase-runner can compute
 * the same digest with a standard shell command. Unreadable files are skipped
 * (matches `cat` of the readable files). Lets the recorder verify the runner's
 * self-reported sha against what's actually on disk.
 */
export function sha256OfFiles(cwd, relPaths) {
  const h = createHash('sha256');
  const list = Array.isArray(relPaths) ? relPaths : [];
  for (const rel of list) {
    try { h.update(readFileSync(join(cwd, rel))); }
    catch { /* skip unreadable, mirroring `cat` */ }
  }
  return h.digest('hex');
}

/** PURE. Build the append-only ledger record for a validated receipt. */
export function buildReceiptRecord(receipt, { nowIso = null, shaVerified = null } = {}) {
  return {
    phase_id: receipt.phase_id,
    verdict: receipt.verdict,
    artifacts_sha256: receipt.artifacts_sha256,
    tests: receipt.tests ?? null,
    files_changed: receipt.files_changed ?? null,
    artifacts: Array.isArray(receipt.artifacts) ? receipt.artifacts : null,
    sha_verified: shaVerified,
    recorded_at: nowIso,
  };
}
