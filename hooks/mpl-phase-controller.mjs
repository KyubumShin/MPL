#!/usr/bin/env node
/**
 * MPL Phase Controller Hook (Stop)
 * Manages phase transitions and loop continuation for the MPL pipeline.
 *
 * Based on: design doc section 9.2 hook 3 + OMC persistent-mode.mjs pattern
 *
 * Phase transitions:
 * - phase2-sprint: checks PLAN.md TODOs → all done → phase3-gate
 * - phase3-gate: checks gate results → all pass → phase5-finalize, any fail → phase4-fix
 * - phase4-fix: checks fix_loop_count → exceeded / stagnating → phase5-finalize, else continue
 * - phase5-finalize: completion message + deactivate MPL
 *
 * Always returns continue: true to keep the pipeline loop running until completion.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import shared MPL state utility
const { readState, writeState, isMplActive, checkConvergence } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

// Import shared stdin reader
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

// Enforcement policy resolver (P0-2, #110)
const { resolveRuleAction } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-enforcement.mjs')).href
);

/**
 * Check PLAN.md checkbox completion status
 */
function checkPlanStatus(cwd) {
  const planPaths = [
    join(cwd, '.mpl', 'PLAN.md'),
    join(cwd, 'PLAN.md'),
  ];

  for (const planPath of planPaths) {
    if (!existsSync(planPath)) continue;

    const content = readFileSync(planPath, 'utf-8');
    // Tolerant regex: accepts whitespace variations, case-insensitive x/X, FAILED/failed
    const todoPattern = /###\s*\[\s*(x|X|FAILED|failed| )\s*\]/g;
    const matches = [...content.matchAll(todoPattern)];

    if (matches.length === 0) return { total: 0, completed: 0, failed: 0 };

    let completed = 0;
    let failed = 0;
    for (const m of matches) {
      const val = m[1].trim();
      if (val.toLowerCase() === 'x') completed++;
      else if (val.toLowerCase() === 'failed') failed++;
    }

    return { total: matches.length, completed, failed };
  }

  return null;
}

/**
 * Check gate results from state.
 *
 * Reads structured evidence (`hard1_baseline`, `hard2_coverage`, `hard3_resilience`)
 * written by `mpl-gate-recorder` from real Bash exit codes. Decision tree:
 *
 *   1. Any present structured entry with `exit_code !== 0` → anyFailed=true.
 *      Machine-recorded failure dominates self-reported legacy — never let legacy
 *      booleans mask a recorded nonzero exit (PR #119 review blocker).
 *   2. All 3 structured present and zero failures → allPassed=true.
 *   3. Partial structured (some present, none failed, some missing) → allPassed=false,
 *      anyFailed=false, source='structured'. Per issue #102 spec ("하나라도 missing →
 *      allPassed=false"), do NOT fall through to legacy. Once mpl-gate-recorder has
 *      produced any structured entry, the rest must follow.
 *   4. Zero structured + strict → blocked (no machine evidence at all).
 *   5. Zero structured + non-strict → legacy boolean fallback with caller-surfaced
 *      warn (transitional; retired when `enforcement.strict` rolls out, #110).
 *
 * @param {object} state - parsed `.mpl/state.json`
 * @param {{ strict?: boolean }} [opts] - strict mode disables zero-structured legacy fallback
 * @returns {{
 *   allPassed: boolean,
 *   anyFailed: boolean,
 *   source: 'structured' | 'legacy' | 'none',
 *   missingEvidence: string[],
 *   details: { hard1: boolean|null, hard2: boolean|null, hard3: boolean|null }
 * }}
 */
function checkGateResults(state, opts = {}) {
  const gates = (state && state.gate_results) || {};
  const strict = opts.strict === true;

  const structuredEntries = {
    hard1: gates.hard1_baseline,
    hard2: gates.hard2_coverage,
    hard3: gates.hard3_resilience,
  };

  const isStructuredEntry = (e) => e && typeof e === 'object' && typeof e.exit_code === 'number';
  const presentEntries = Object.values(structuredEntries).filter(isStructuredEntry);
  const structuredCount = presentEntries.length;

  const missingEvidence = [];
  if (!isStructuredEntry(structuredEntries.hard1)) missingEvidence.push('hard1_baseline');
  if (!isStructuredEntry(structuredEntries.hard2)) missingEvidence.push('hard2_coverage');
  if (!isStructuredEntry(structuredEntries.hard3)) missingEvidence.push('hard3_resilience');

  const detailsFromStructured = () => ({
    hard1: isStructuredEntry(structuredEntries.hard1) ? structuredEntries.hard1.exit_code === 0 : null,
    hard2: isStructuredEntry(structuredEntries.hard2) ? structuredEntries.hard2.exit_code === 0 : null,
    hard3: isStructuredEntry(structuredEntries.hard3) ? structuredEntries.hard3.exit_code === 0 : null,
  });

  // Step 1: machine-recorded failure dominates. Even one structured entry with
  // nonzero exit_code forces anyFailed=true, irrespective of legacy booleans.
  // Closes PR #119 review blocker (legacy true + structured nonzero must not pass).
  if (presentEntries.some(e => e.exit_code !== 0)) {
    return {
      allPassed: false,
      anyFailed: true,
      source: 'structured',
      missingEvidence,
      details: detailsFromStructured(),
    };
  }

  // Step 2: all 3 structured present and zero failures → genuine pass.
  if (structuredCount === 3) {
    return {
      allPassed: true,
      anyFailed: false,
      source: 'structured',
      missingEvidence: [],
      details: { hard1: true, hard2: true, hard3: true },
    };
  }

  // Step 3: partial structured (1 or 2 present, none failed, some missing).
  // Issue #102 spec: "하나라도 missing → allPassed=false". Once gate-recorder has
  // started producing structured entries, the rest are required — legacy fallback
  // would let a phase-runner skip a gate by self-reporting only.
  if (structuredCount > 0) {
    return {
      allPassed: false,
      anyFailed: false,
      source: 'structured',
      missingEvidence,
      details: detailsFromStructured(),
    };
  }

  // Step 4: zero structured + strict → block (no machine evidence at all).
  if (strict) {
    return {
      allPassed: false,
      anyFailed: false,
      source: 'structured',
      missingEvidence,
      details: detailsFromStructured(),
    };
  }

  // Step 5: zero structured + non-strict → legacy boolean fallback (transitional).
  // Phase3-gate caller surfaces a system-reminder ⚠ on `source === 'legacy'`.
  // Retired once `enforcement.strict` ships (#110, P0-2).
  const hardResults = [gates.hard1_passed, gates.hard2_passed, gates.hard3_passed];
  const required = hardResults.filter(r => r !== null && r !== undefined);
  const passed = required.filter(r => r === true);
  const failed = required.filter(r => r === false);

  return {
    allPassed: failed.length === 0 && passed.length > 0,
    anyFailed: failed.length > 0,
    source: required.length === 0 ? 'none' : 'legacy',
    missingEvidence,
    details: {
      hard1: gates.hard1_passed,
      hard2: gates.hard2_passed,
      hard3: gates.hard3_passed,
    },
  };
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();

  // Check if MPL is active
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const state = readState(cwd);
  if (!state) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const phase = state.current_phase;

  switch (phase) {
    case 'mpl-init': {
      // Init phase: triage + interview in progress
      console.log(JSON.stringify({
        continue: true,
        stopReason: '[MPL] Initialization in progress. Complete Triage → Stage 1 (PP Interview) → Stage 2 (Ambiguity Resolution) before Decomposition.'
      }));
      break;
    }

    case 'mpl-decompose': {
      // GATE: ambiguity_score MUST exist AND meet threshold before decomposition proceeds.
      // Stage 2 (Ambiguity Resolution) writes ambiguity_score to state via the mpl_score_ambiguity MCP tool.
      const ambiguityScore = state.ambiguity_score;
      const hasScore = ambiguityScore !== null && ambiguityScore !== undefined;
      const threshold = 0.2;

      if (!hasScore) {
        // Block decomposition — ambiguity resolution was skipped
        writeState(cwd, { current_phase: 'mpl-ambiguity-resolve' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL] ⛔ Decomposition BLOCKED: ambiguity_score not found in state. ' +
            'Reverting to Stage 2 Ambiguity Resolution. ' +
            'Call mpl_score_ambiguity MCP tool with pivot_points + user_responses, then persist the result via mpl_state_write.'
        }));
      } else if (ambiguityScore > threshold) {
        // Block decomposition — score exceeds threshold, re-run ambiguity resolution
        writeState(cwd, { current_phase: 'mpl-ambiguity-resolve' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] ⛔ Decomposition BLOCKED: ambiguity_score=${ambiguityScore} exceeds threshold ${threshold}. ` +
            'Reverting to Stage 2 Ambiguity Resolution for additional Socratic resolution. ' +
            'Re-call mpl_score_ambiguity MCP tool with updated user_responses targeting the weakest dimension.'
        }));
      } else {
        // Score exists and meets threshold — proceed
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Decomposition: ambiguity_score=${ambiguityScore} (threshold: <=${threshold}). ✓ Proceed with micro-phase decomposition.`
        }));
      }
      break;
    }

    case 'mpl-ambiguity-resolve': {
      // Stage 2: Ambiguity Resolution in progress
      const currentScore = state.ambiguity_score;
      const hasCurrentScore = currentScore !== null && currentScore !== undefined;
      const ambThreshold = 0.2;

      if (hasCurrentScore && currentScore <= ambThreshold) {
        // Threshold met — transition to decompose
        writeState(cwd, { current_phase: 'mpl-decompose' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Ambiguity resolved: score=${currentScore} (<=${ambThreshold}). Transitioning to Decomposition.`
        }));
      } else {
        const scoreInfo = hasCurrentScore ? ` Current score: ${currentScore}.` : '';
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Stage 2: Ambiguity Resolution in progress.${scoreInfo} Target: <=${ambThreshold}. ` +
            'Drive the Socratic loop inline: call mpl_score_ambiguity MCP tool after each user response and persist via mpl_state_write.'
        }));
      }
      break;
    }

    case 'phase1-plan': {
      // Phase 1: Quick Plan (legacy/backward-compat when research is skipped)
      console.log(JSON.stringify({
        continue: true,
        stopReason: '[MPL] Phase 1: Quick Plan in progress. Complete planning and HITL before proceeding.'
      }));
      break;
    }

    case 'phase1a-research': {
      // Phase 1-A: Deep Research — check research.status for auto-transition
      const research = state.research || {};

      // BUG-6 fix: handle research error state to prevent infinite loop
      if (research.error) {
        writeState(cwd, { current_phase: 'phase1b-plan', research: { status: 'skipped' } });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Research failed: ${research.error}. Skipping to Phase 1-B: Plan Generation (without research).`
        }));
        break;
      }

      if (research.status === 'completed' || research.status === 'skipped') {
        // Research done → transition to Phase 1-B: Plan Generation
        writeState(cwd, { current_phase: 'phase1b-plan' });
        const msg = research.status === 'skipped'
          ? '[MPL] Research skipped. Transitioning to Phase 1-B: Plan Generation.'
          : `[MPL] Research completed (${research.stages_completed?.length || 0} stages, ${research.findings_count || 0} findings, ${research.sources_count || 0} sources). Transitioning to Phase 1-B: Plan Generation.`;
        console.log(JSON.stringify({
          continue: true,
          stopReason: msg
        }));
      } else {
        // Research in progress — guide orchestrator
        const currentStage = research.status || 'not started';
        const stagesCompleted = research.stages_completed?.length || 0;
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Phase 1-A: Deep Research in progress (stage: ${currentStage}, ${stagesCompleted}/3 stages completed). Complete all research stages or skip to proceed.`
        }));
      }
      break;
    }

    case 'phase1b-plan': {
      // Phase 1-B: Plan Generation — same as phase1-plan but after research
      // Orchestrator handles PLAN.md creation + HITL; no auto-transition
      const reportPath = state.research?.report_path;
      const reportNote = reportPath ? ` Research report: ${reportPath}.` : '';
      console.log(JSON.stringify({
        continue: true,
        stopReason: `[MPL] Phase 1-B: Plan Generation in progress.${reportNote} Use research findings as input for planning agents. Complete PLAN.md and HITL before proceeding.`
      }));
      break;
    }

    case 'phase2-sprint': {
      // v0.17 (#55): interview_depth guard removed. Phase 0 no longer has
      // light/full dual-track — Stage 1 always runs full depth.

      // Check PLAN.md completion
      const planStatus = checkPlanStatus(cwd);
      if (!planStatus || planStatus.total === 0) {
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL] Phase 2: Sprint in progress. No PLAN.md found or no TODOs defined.'
        }));
        break;
      }

      const { total, completed, failed } = planStatus;
      const remaining = total - completed - failed;

      if (remaining === 0) {
        // All TODOs resolved (completed or failed) → Phase 3
        writeState(cwd, { current_phase: 'phase3-gate' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] All TODOs resolved (${completed} completed, ${failed} failed). Transitioning to Phase 3: Quality Gate.`
        }));
      } else {
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Phase 2: Sprint in progress. ${completed}/${total} TODOs completed, ${failed} failed, ${remaining} remaining.`
        }));
      }
      break;
    }

    case 'phase3-gate': {
      // Per-rule policy (P0-2, #110): `missing_gate_evidence` resolves the
      // strict toggle for checkGateResults. Default DEFAULTS.enforcement
      // value is 'block' — zero-structured-evidence transitions block out of
      // the box. Workspace can downgrade to 'warn' (legacy fallback surfaced)
      // or 'off' (legacy fallback silent) for transitional environments.
      // Precedence: state.enforcement > .mpl/config.json > plugin baseline.
      const gateRuleAction = resolveRuleAction(cwd, state, 'missing_gate_evidence');
      const enforcementStrict = gateRuleAction === 'block';
      const gateResults = checkGateResults(state, { strict: enforcementStrict });

      const fallbackWarn = (gateResults.source === 'legacy' && gateRuleAction !== 'off')
        ? ' ⚠ Using legacy gate boolean fallback (no structured evidence in state.gate_results.hard{1,2,3}_{baseline,coverage,resilience}). exp16 strict mode will block this transition. Run real verification commands so mpl-gate-recorder can record exit codes.'
        : '';

      if (gateResults.allPassed) {
        // All gates passed → Phase 5
        writeState(cwd, { current_phase: 'phase5-finalize' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] All Quality Gates passed (source=${gateResults.source}). Transitioning to Phase 5: Finalize.${fallbackWarn}`
        }));
      } else if (gateResults.anyFailed) {
        // Gate failed → Phase 4
        // Preserve existing fix_loop_count to prevent infinite loop bypass
        // (only initialize to 0 on first entry, not on re-entry from Phase 3)
        const currentFixCount = state.fix_loop_count || 0;
        // Reset both legacy and structured gate evidence on retry to prevent stale data.
        writeState(cwd, {
          current_phase: 'phase4-fix',
          fix_loop_count: currentFixCount,
          gate_results: {
            hard1_passed: null, hard2_passed: null, hard3_passed: null,
            hard1_baseline: null, hard2_coverage: null, hard3_resilience: null,
          }
        });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Quality Gate failed (source=${gateResults.source}). Gate results: H1=${gateResults.details.hard1}, H2=${gateResults.details.hard2}, H3=${gateResults.details.hard3}. Transitioning to Phase 4: Fix Loop.${fallbackWarn}`
        }));
      } else if (gateResults.source === 'structured' && gateResults.missingEvidence.length > 0) {
        // Partial structured evidence: gate-recorder produced some entries but not all.
        // Issue #102 spec ("missing → false") + non-strict UX (E-gap from PR #119 smoke):
        // surface the explicit missing list whether or not strict mode is on. The
        // wording adapts to whether transition is hard-blocked (strict) or "in progress"
        // (non-strict — phase will retry on next Stop event after the missing gates record).
        const verb = enforcementStrict ? '⛔ BLOCKED' : 'in progress';
        const tail = enforcementStrict
          ? 'Strict enforcement requires all 3 gates to be recorded by mpl-gate-recorder via real Bash exit codes. Self-reported booleans are not accepted.'
          : `Run the missing gates so mpl-gate-recorder writes structured evidence; the loop will continue once all 3 ${gateResults.missingEvidence.length === 3 ? 'are' : 'remaining are'} recorded.`;
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Phase 3 ${verb}: missing structured gate evidence (${gateResults.missingEvidence.join(', ')}). ${tail}`
        }));
      } else {
        // No gate evidence at all (zero structured + zero legacy).
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Phase 3: Quality Gate in progress. Run all 3 gates before proceeding.${fallbackWarn}`
        }));
      }
      break;
    }

    case 'phase4-fix': {
      const fixCount = state.fix_loop_count || 0;
      const maxFix = state.max_fix_loops || 10;

      if (fixCount >= maxFix) {
        // Fix loop limit reached → Phase 5 (partial completion)
        writeState(cwd, { current_phase: 'phase5-finalize' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Fix loop limit reached (${fixCount}/${maxFix}). Transitioning to Phase 5: Finalize (partial completion).`
        }));
      } else {
        // H1: Check convergence before continuing
        const convergenceResult = checkConvergence(state);
        if (convergenceResult.status === 'stagnating' || convergenceResult.status === 'regressing') {
          writeState(cwd, { current_phase: 'phase5-finalize' });
          console.log(JSON.stringify({
            continue: true,
            stopReason: `[MPL] Convergence ${convergenceResult.status} detected (delta: ${convergenceResult.delta?.toFixed(3)}). Fix loop is not improving. Transitioning to Phase 5: Finalize (partial completion).`
          }));
        } else {
          // Continue fix loop
          console.log(JSON.stringify({
            continue: true,
            stopReason: `[MPL] Phase 4: Fix Loop ${fixCount}/${maxFix}. Continue fixing or re-run Quality Gate.`
          }));
        }
      }
      break;
    }

    case 'phase5-finalize': {
      // Finalize: do NOT auto-transition to completed here.
      // The orchestrator must complete finalization tasks (extract learnings, commit)
      // and then manually set current_phase to 'completed' via writeState.
      const finalized = state.finalize_done === true;
      if (finalized) {
        writeState(cwd, { current_phase: 'completed' });
        console.log(JSON.stringify({
          continue: false,
          stopReason: '[MPL] Phase 5: Finalize complete. MPL pipeline finished.'
        }));
      } else {
        // Protocol load enforcement: remind orchestrator to load finalize protocol
        // This prevents the exp5 failure where finalize rules were never read
        const protocolReminder = '\n\nIMPORTANT: Before proceeding, you MUST read the finalize protocol documents:\n' +
          '1. Read the gate execution protocol (mpl-run-execute-gates or equivalent)\n' +
          '2. Read the finalize protocol (mpl-run-finalize or equivalent)\n' +
          '3. Execute all Hard Gates (H1: Build+Lint+Type, H2: Full Test Suite, H3: Contract Diff Guard)\n' +
          '4. Run project-root-level tests (cargo test --workspace, npx vitest run, pytest, etc.)\n' +
          '5. Check platform-constraints.md violations if it exists in .mpl/mpl/phase0/';
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL] Phase 5: Finalize in progress. Extract learnings, commit, then set state.finalize_done = true to complete.' + protocolReminder
        }));
      }
      break;
    }

    // === Small Pipeline Phases (3-Phase Lightweight) ===

    case 'small-plan': {
      // Small Plan: orchestrator handles, no auto-transition
      console.log(JSON.stringify({
        continue: true,
        stopReason: '[MPL-Small] Phase 1: Small Plan in progress. Complete planning and HITL before proceeding.'
      }));
      break;
    }

    case 'small-sprint': {
      // Check PLAN.md completion (reuse checkPlanStatus)
      const smallPlanStatus = checkPlanStatus(cwd);
      if (!smallPlanStatus || smallPlanStatus.total === 0) {
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL-Small] Phase 2: Sprint in progress. No PLAN.md found or no TODOs defined.'
        }));
        break;
      }

      const { total: sTotal, completed: sCompleted, failed: sFailed } = smallPlanStatus;
      const sRemaining = sTotal - sCompleted - sFailed;

      if (sRemaining === 0) {
        // All TODOs resolved → small-verify
        writeState(cwd, { current_phase: 'small-verify' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL-Small] All TODOs resolved (${sCompleted} completed, ${sFailed} failed). Transitioning to Phase 3: Verify.`
        }));
      } else {
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL-Small] Phase 2: Sprint in progress. ${sCompleted}/${sTotal} TODOs completed, ${sFailed} failed, ${sRemaining} remaining.`
        }));
      }
      break;
    }

    case 'small-verify': {
      // Simplified verification: only hard2 (code review)
      const smallGate = state.gate_results || {};

      if (smallGate.hard2_passed === true) {
        // Code review passed → completed
        writeState(cwd, { current_phase: 'completed' });
        console.log(JSON.stringify({
          continue: false,
          stopReason: '[MPL-Small] Verification passed. Pipeline complete. Extract learnings and commit.'
        }));
      } else if (smallGate.hard2_passed === false) {
        const smallFixCount = state.fix_loop_count || 0;
        const smallMaxFix = state.max_fix_loops || 3;

        if (smallFixCount >= smallMaxFix) {
          // Fix loop limit reached → completed (partial)
          writeState(cwd, { current_phase: 'completed' });
          console.log(JSON.stringify({
            continue: false,
            stopReason: `[MPL-Small] Fix loop limit reached (${smallFixCount}/${smallMaxFix}). Completing with partial results. Extract learnings.`
          }));
        } else {
          // Review failed, retries remaining → back to small-sprint
          writeState(cwd, { current_phase: 'small-sprint', fix_loop_count: smallFixCount + 1 });
          console.log(JSON.stringify({
            continue: true,
            stopReason: `[MPL-Small] Code review failed. Retry ${smallFixCount + 1}/${smallMaxFix}. Returning to Sprint for fixes.`
          }));
        }
      } else {
        // Gate not yet evaluated
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL-Small] Phase 3: Verify in progress. Run code review before proceeding.'
        }));
      }
      break;
    }

    default: {
      // Unknown or completed phase
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  }
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});

export { checkPlanStatus, checkGateResults };
