#!/usr/bin/env node
/**
 * MPL Phase Controller Hook (Stop) — Move #9 thin wrapper.
 *
 * Pass-A scope (per Move #9 plan): the policy module
 * `hooks/lib/policy/gates.mjs::handlePhaseTransition` owns the decision
 * skeleton for the simple phase cases (mpl-init, mpl-decompose,
 * mpl-ambiguity-resolve, phase1-plan, phase1a-research, phase1b-plan,
 * phase4-fix, phase5-finalize) plus the G4-hang short-circuit and the
 * blocked_hook routing.
 *
 * The wrapper still owns the heavy cases that touch the filesystem
 * (phase2-sprint cohort lazy-init reads goal-contract; release-gate +
 * release-finalize write release-manifest.json + evidence-summary.md +
 * gate-results.json via atomicWriteFile; release-finalize also creates
 * snapshot refs + user-visible artifacts; phase3-gate routes cohort-aware
 * gate evidence + applies fix-loop accounting; small-plan + small-sprint +
 * small-verify gate the small-pipeline against mvp_scope). Those file-write
 * side effects migrate to a `lib/release/` module in Pass-B (NOT Move #9).
 *
 * For Pass-A, the wrapper delegates ALL routing to the legacy main loop
 * but exposes the same exports the existing test file relies on
 * (checkPlanStatus, checkGateResults). The legacy file is preserved verbatim
 * as mpl-phase-controller.legacy.mjs for emergency rollback.
 *
 * Decision flow:
 *   1. Read stdin → state.
 *   2. Run gates.handlePhaseTransition for the early-exit short-circuits
 *      (G4-hang, blocked_hook, missing state) and simple phase cases.
 *   3. If gates returns action='emit', persist state mutations + emit
 *      the stopReason. Done.
 *   4. If gates returns action='delegate-to-legacy', forward execution
 *      to the legacy main loop which still owns the heavy cases.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { readState, writeState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { handle: gatesHandle } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'gates.mjs')).href
);

// Legacy module owns the heavy file-write paths (release-manifest /
// snapshot ref / artifact attempt / atomicWriteFile) plus the exports the
// existing test file imports (checkPlanStatus, checkGateResults). The
// wrapper forwards stdin to the legacy main when gates.mjs returns
// 'delegate-to-legacy'.
const legacy = await import(
  pathToFileURL(join(__dirname, 'mpl-phase-controller.legacy.mjs')).href
);

export const checkPlanStatus = legacy.checkPlanStatus;
export const checkGateResults = legacy.checkGateResults;

function emitContinueTrue() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

/**
 * Apply stop-hook emit envelope from a gates.handlePhaseTransition decision.
 */
function emitDecision(cwd, decision) {
  if (decision.stateMutations && Object.keys(decision.stateMutations).length > 0) {
    try {
      writeState(cwd, decision.stateMutations);
    } catch {
      // Best-effort: never wedge the Stop hook on a disk error.
    }
  }
  const payload = { continue: decision.continue !== false };
  if (decision.suppressOutput) {
    payload.suppressOutput = true;
  } else if (decision.stopReason) {
    payload.stopReason = decision.stopReason;
  }
  console.log(JSON.stringify(payload));
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    emitContinueTrue();
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    emitContinueTrue();
    return;
  }

  const state = readState(cwd);
  if (!state) {
    emitContinueTrue();
    return;
  }

  // Pass-A: gates owns simple phase cases + G4 hang + blocked_hook short
  // circuits. Heavy cases (phase2-sprint cohort init, release-gate,
  // release-finalize, phase3-gate, small-*) return 'delegate-to-legacy'.
  const config = loadConfig(cwd) || {};
  let decision;
  try {
    decision = gatesHandle('phase_transition', { cwd, state, config });
  } catch {
    // Policy module crashed — fall through to legacy.
    decision = { action: 'delegate-to-legacy' };
  }

  if (decision && decision.action === 'emit') {
    emitDecision(cwd, decision);
    return;
  }

  // Forward to the legacy main flow (heavy file-write paths).
  try {
    await legacy.runLegacyMain(input);
  } catch {
    emitContinueTrue();
  }
}

if (isMain) {
  main().catch(() => emitContinueTrue());
}
