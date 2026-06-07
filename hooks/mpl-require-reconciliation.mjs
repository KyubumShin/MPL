#!/usr/bin/env node
/**
 * MPL Require Reconciliation Hook (PreToolUse on Task|Agent dispatching
 * mpl-phase-runner for a phase whose dependencies hit a still-open wave).
 *
 * Move #17 — gates ALL dependent-phase frontier dispatch until
 * `hooks/lib/policy/reconcile/index.mjs#reconcileWave` has produced a
 * terminal outcome ∈ {clean, reconciled, aborted}. Pending verifier =>
 * dependent phases STAY PENDING in state.phase_lifecycle.
 *
 * The gate consumes `.mpl/signals/reconcile/wave-reconciliation.json`
 * (always written) and, when bucket C non-empty, also
 * `.mpl/signals/reconcile/wave-<tier>-<wave>-reconciler-verdict.json`.
 *
 * Legacy stdout contract:
 *   allow → {continue:true, suppressOutput:true}
 *   block → emitBlockedHook with code='reconcile_pending' or 'reconcile_aborted'
 *
 * Non-blocking on error: every exception → ok(). The gate is dormant
 * when no reconciliation signal exists for the wave (nothing to
 * adjudicate yet) — see the early-return below.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { readStdin } = isMain
  ? await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href)
  : { readStdin: async () => '' };
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);

export const HOOK_ID = 'mpl-require-reconciliation';
const BLOCKED_ARTIFACT = '.mpl/signals/reconcile/wave-reconciliation.json';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function isPhaseRunnerDispatch(toolName, toolInput) {
  if (!/^(Task|Agent)$/.test(String(toolName || ''))) return false;
  const sub = String(
    toolInput?.subagent_type
    || toolInput?.subagentType
    || ''
  );
  return /mpl-phase-runner/.test(sub);
}

function readReconciliationJson(cwd) {
  const path = join(cwd, '.mpl', 'signals', 'reconcile', 'wave-reconciliation.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

/**
 * @param {object} reconciliation  parsed wave-reconciliation.json
 * @returns {'allow'|'block_pending'|'block_aborted'}
 */
export function classifyReconciliation(reconciliation) {
  if (!reconciliation || typeof reconciliation !== 'object') return 'allow';
  const outcome = reconciliation.outcome;
  if (outcome === 'clean' || outcome === 'reconciled') return 'allow';
  if (outcome === 'pending_verifier') return 'block_pending';
  if (outcome === 'aborted') return 'block_aborted';
  return 'allow';
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.tool_input || data.toolInput || {};
  if (!isPhaseRunnerDispatch(toolName, toolInput)) return ok();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  // Config opt-out: reconcile.gate_dependent_frontier=false silences the gate.
  let cfg;
  try { cfg = loadConfig(cwd); } catch { cfg = {}; }
  // Legacy loadConfig won't surface YAML-only knobs; do best-effort YAML lookup.
  // (Move #17 keeps the YAML accessor optional; absence = use default true.)

  const reconciliation = readReconciliationJson(cwd);
  if (!reconciliation) {
    // No active reconciliation signal — wave hasn't ended yet (or no
    // parallel wave shipped this run). The gate is dormant in that case.
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  const verdict = classifyReconciliation(reconciliation);
  const state = readState(cwd) || {};

  if (verdict === 'allow') {
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  if (verdict === 'block_pending') {
    emitBlockedHook(cwd, state, {
      hookId: HOOK_ID,
      ruleId: 'reconcile_pending_verifier',
      code: 'reconcile_pending',
      artifact: BLOCKED_ARTIFACT,
      reason: `Wave ${reconciliation.wave_id} reconciliation pending verifier; dependent-phase dispatch is blocked until mpl-adversarial-reviewer --mode=reconcile writes wave-<tier>-<wave>-reconciler-verdict.json.`,
      resumeInstruction: 'Dispatch mpl-adversarial-reviewer --mode=reconcile for every bucket C conflict; then re-run wave_end to re-classify.',
      retryContext: { wave_id: reconciliation.wave_id, buckets: reconciliation.buckets },
    });
    return;
  }

  // verdict === 'block_aborted'
  emitBlockedHook(cwd, state, {
    hookId: HOOK_ID,
    ruleId: 'reconcile_aborted',
    code: reconciliation.failure_code || 'reconcile_aborted',
    artifact: BLOCKED_ARTIFACT,
    reason: `Wave ${reconciliation.wave_id} reconciliation ABORTED (failure_code=${reconciliation.failure_code || 'unspecified'}).`,
    resumeInstruction: 'Issue a decomposition delta (recompose) to resolve the conflict before resuming dependent phases.',
    retryContext: { wave_id: reconciliation.wave_id, failure_code: reconciliation.failure_code, buckets: reconciliation.buckets },
  });
}

if (isMain) {
  await main().catch(() => ok());
}
