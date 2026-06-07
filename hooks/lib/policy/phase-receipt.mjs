/**
 * exp25 R04 (part b) — phase-runner receipt recorder (PostToolUse Task|Agent).
 *
 * Parses the compact receipt from a phase-runner's return, validates it, verifies
 * its sha256 against the on-disk artifacts, and appends it to an append-only audit
 * ledger (.mpl/mpl/receipts.jsonl). A missing/malformed receipt or a sha mismatch
 * surfaces an EXPLICIT advisory (never silent) — the orchestrator is told exactly
 * what to emit / that the summary may be stale. Never blocks: a completed
 * phase-runner must not be stalled by a handoff-format issue.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import {
  parseReceipt,
  validateReceipt,
  sha256OfFiles,
  buildReceiptRecord,
  RECEIPT_AGENTS,
  VALID_VERDICTS,
} from '../phase-receipt.mjs';

const RECEIPT_SHAPE_HINT =
  `Return a compact { "receipt": { "phase_id", "verdict" (one of `
  + `${VALID_VERDICTS.join('/')}), "artifacts_sha256" (sha256 of the phase's `
  + `state-summary.md + verification.md), "tests", "files_changed", "artifacts": `
  + `[relative paths] } } so the orchestrator hands off by reference (sha + verdict + `
  + `pointers), not by inlining the full state_summary prose.`;

function noop(ruleId) { return { action: 'noop', ruleId }; }
function advisory(ruleId, code, reason) {
  return { action: 'advisory', ruleId, code, reason, additionalContext: reason };
}

export function handlePhaseReceipt(ctx = {}) {
  const { toolName, toolInput, toolResponse, cwd, mplActive } = ctx;
  if (!/^(task|agent)$/i.test(String(toolName || ''))) return noop('receipt_irrelevant_tool');
  if (!mplActive) return noop('receipt_mpl_inactive');

  const agentType = (toolInput && (toolInput.subagent_type || toolInput.subagentType)) || '';
  if (!RECEIPT_AGENTS.has(agentType)) return noop('receipt_not_receipt_agent');

  const text = typeof toolResponse === 'string'
    ? toolResponse
    : (toolResponse ? JSON.stringify(toolResponse) : '');
  const receipt = parseReceipt(text);
  const { valid, errors } = validateReceipt(receipt);
  if (!valid) {
    return advisory(
      'phase_receipt_missing',
      'phase_receipt_missing',
      `[MPL receipt] phase-runner return is missing a well-formed receipt `
      + `(${errors.join(', ')}). ${RECEIPT_SHAPE_HINT}`,
    );
  }

  // Verify the runner's self-reported sha against the actual on-disk artifacts.
  let shaVerified = null;
  try {
    if (Array.isArray(receipt.artifacts) && receipt.artifacts.length) {
      shaVerified = sha256OfFiles(cwd, receipt.artifacts) === receipt.artifacts_sha256;
    }
  } catch { shaVerified = null; }

  // Append-only audit ledger (best-effort; a write failure never blocks).
  try {
    const dir = join(cwd, '.mpl', 'mpl');
    mkdirSync(dir, { recursive: true });
    const rec = buildReceiptRecord(receipt, { nowIso: new Date().toISOString(), shaVerified });
    appendFileSync(join(dir, 'receipts.jsonl'), `${JSON.stringify(rec)}\n`);
  } catch { /* best-effort audit */ }

  if (shaVerified === false) {
    return advisory(
      'phase_receipt_sha_mismatch',
      'phase_receipt_sha_mismatch',
      `[MPL receipt] phase '${receipt.phase_id}' receipt artifacts_sha256 does NOT match the `
      + `on-disk artifacts — the summary may be stale or hand-edited. Re-derive the receipt from `
      + `the actual state-summary.md / verification.md before handing off.`,
    );
  }

  return noop('phase_receipt_recorded');
}

export function handle(event, ctx = {}) {
  if (event === 'phase_receipt') return handlePhaseReceipt(ctx);
  throw new Error(`policy/phase-receipt.mjs: unknown event '${event}'`);
}
