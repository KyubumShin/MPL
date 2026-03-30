#!/usr/bin/env node
/**
 * MPL Phase Controller Hook (Stop)
 * Manages phase transitions and loop continuation for the MPL pipeline.
 *
 * Based on: design doc section 9.2 hook 3 + OMC persistent-mode.mjs pattern
 *
 * Phase transitions:
 * - mpl-phase-running: checks decomposition.yaml TODOs → all done → mpl-phase-complete
 * - mpl-phase-complete: checks gate results → all pass → mpl-finalize, any fail → mpl-circuit-break
 * - mpl-circuit-break: checks fix_loop_count → exceeded → mpl-finalize, else continue
 * - mpl-finalize: completion message + deactivate MPL
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
 * Check gate results from state
 */
function checkGateResults(state) {
  const gates = state.gate_results || {};
  // Hard gates are mandatory; advisory is informational only
  const hardResults = [gates.hard1_passed, gates.hard2_passed, gates.hard3_passed];

  const required = hardResults.filter(r => r !== null && r !== undefined);
  const passed = required.filter(r => r === true);
  const failed = required.filter(r => r === false);

  return {
    allPassed: failed.length === 0 && passed.length > 0,
    anyFailed: failed.length > 0,
    details: {
      hard1: gates.hard1_passed,
      hard2: gates.hard2_passed,
      hard3: gates.hard3_passed,
      advisory: gates.advisory_passed,
    }
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
      // Triage guard: ensure interview_depth was recorded before execution
      if (!state.interview_depth) {
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL] Triage guard: interview_depth not recorded in state. Run Triage (Step 0) to set interview_depth (skip/light/full) before proceeding to Sprint.'
        }));
        break;
      }

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
      // Check gate results
      const gateResults = checkGateResults(state);

      if (gateResults.allPassed) {
        // All gates passed → Phase 5
        writeState(cwd, { current_phase: 'phase5-finalize' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL] All Quality Gates passed! Transitioning to Phase 5: Finalize.'
        }));
      } else if (gateResults.anyFailed) {
        // Gate failed → Phase 4
        // Preserve existing fix_loop_count to prevent infinite loop bypass
        // (only initialize to 0 on first entry, not on re-entry from Phase 3)
        const currentFixCount = state.fix_loop_count || 0;
        // Reset gate results when re-entering gate phase to prevent stale data
        writeState(cwd, {
          current_phase: 'phase4-fix',
          fix_loop_count: currentFixCount,
          gate_results: { hard1_passed: null, hard2_passed: null, hard3_passed: null, advisory_passed: null }
        });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Quality Gate failed. Gate results: H1=${gateResults.details.hard1}, H2=${gateResults.details.hard2}, H3=${gateResults.details.hard3}, Adv=${gateResults.details.advisory}. Transitioning to Phase 4: Fix Loop.`
        }));
      } else {
        // Gates not yet evaluated
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL] Phase 3: Quality Gate in progress. Run all 3 gates before proceeding.'
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
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL] Phase 5: Finalize in progress. Extract learnings, commit, then set state.finalize_done = true to complete.'
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
