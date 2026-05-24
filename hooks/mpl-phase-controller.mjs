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
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';

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

// Stage A: goal-contract reader for the D-Q7 small-pipeline guard.
const { readGoalContract } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-contract.mjs')).href
);

// Stage A Phase 1.6c-ii: release-manifest serializers for the release-finalize
// file-write step. Pure helpers; this hook owns the filesystem side.
const {
  buildReleaseManifest,
  buildEvidenceSummary,
  buildGateResultsSnapshot,
  RELEASE_DIR_REL_PATH,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-release-manifest.mjs')).href
);

const { parsePhaseContractGraphText } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-phase-contract-graph.mjs')).href
);

// Stage A Phase 1.6c-iii: snapshot ref + user-visible artifact creation.
const { createSnapshotRef, attemptArtifactCreation } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-release-artifact.mjs')).href
);

/**
 * Atomic file write — write to a sibling tmp file then rename onto the
 * final path. Removes the partial-file failure window claude #2 on PR
 * #187 flagged: if a write is interrupted mid-stream, the final path is
 * untouched (the tmp is orphaned, which a future release-finalize
 * re-run reclaims by writing a fresh tmp). All three release artifacts
 * use this so the on-disk state is always "all three present at the
 * same generation" or "the prior generation intact" — never a
 * partial-mix that a consumer could read between writes.
 */
function atomicWriteFile(filePath, contents, mode) {
  const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, contents, { mode });
  renameSync(tmp, filePath);
}

// G4 hang detection (#109)
const { detectHang } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-hang-detector.mjs')).href
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

  let state = readState(cwd);
  if (!state) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // G4 (#109) — hang detection. Run before phase routing so a stalled
  // session is marked even when the phase branch would otherwise return
  // a generic "in progress" message.
  //
  // Three branches:
  //   (a) Newly detected hang (state.last_tool_at is stale, no exempt status):
  //       mark `session_status='verification_hang'` and emit the alarm banner.
  //   (b) Already-marked verification_hang: short-circuit phase routing so
  //       phase transitions (e.g. phase3-gate → phase5-finalize) cannot
  //       advance silently while the session is awaiting user triage. The
  //       resume skill clears the marker only after the user picks resume /
  //       rollback / cancel — until then every Stop tick re-surfaces the
  //       triage guidance. (PR #126 review #1 — was previously a fall-through.)
  //   (c) paused_budget / paused_checkpoint: intentional pauses, untouched.
  const hangDet = detectHang(state, Date.now());
  if (hangDet.hung) {
    try {
      writeState(cwd, { session_status: 'verification_hang' });
    } catch { /* best-effort marking — never fail Stop hook on disk error */ }
    console.log(JSON.stringify({
      continue: true,
      stopReason: hangDet.reason,
    }));
    return;
  }
  if (state.session_status === 'verification_hang') {
    console.log(JSON.stringify({
      continue: true,
      stopReason: '[MPL G4] Session is currently marked verification_hang. Phase routing is paused until user triage. Run /mpl:mpl-resume to choose: resume current phase, roll back, or cancel.',
    }));
    return;
  }
  if (state.session_status === 'blocked_hook') {
    const hook = state.blocked_by_hook || 'unknown hook';
    const blockedPhase = state.blocked_phase || state.current_phase || 'unknown phase';
    const instruction = state.resume_instruction || 'Resolve the recorded hook block, then retry the transition.';
    console.log(JSON.stringify({
      continue: true,
      stopReason:
        `[MPL] Phase routing is paused by ${hook} for ${blockedPhase}. ` +
        `${instruction} Run /mpl:mpl-resume to continue once the missing evidence is restored.`,
    }));
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

      // Stage A Phase 1.6b: lazy-initialize state.release.current_cut_id
      // on first sprint entry when goal_contract.mvp_scope is declared.
      // This is the single lifecycle write point per RFC §4.5: subsequent
      // advancement happens at release-finalize exit. Without an mvp_scope,
      // current_cut_id stays null and the release path is never entered
      // (existing pipeline behavior preserved).
      //
      // RFC §4.5: "Never re-entered for the same cut_id within a single
      // pipeline run." A cohort already in `completed_cut_ids` MUST NOT be
      // re-set here, even if `current_cut_id` is null and the contract
      // still carries `mvp_scope`. This guards the phase3-gate → phase4-fix
      // → recompose → phase2-sprint loop from spuriously re-running the
      // mvp release path after the artifact has shipped.
      if (state.release?.current_cut_id == null) {
        const already = Array.isArray(state.release?.completed_cut_ids)
          ? state.release.completed_cut_ids
          : [];
        if (!already.includes('mvp')) {
          const gc = readGoalContract(cwd);
          if (gc.exists && gc.contract?.mvp_scope) {
            writeState(cwd, {
              release: { ...(state.release || {}), current_cut_id: 'mvp' },
            });
            // Re-read so the routing below sees the freshly-set cohort.
            state = readState(cwd);
          }
        }
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
        // Stage A Phase 1.6b: route based on `state.release.current_cut_id`.
        // - non-null → cohort active, transition to release-gate (scoped Hard
        //   1/2/3 will run there once Phase 1.6c lands; for now the stub
        //   immediately advances to release-finalize)
        // - null → whole-pipeline complete, transition to phase3-gate
        //   (existing pre-Stage-A behavior, unchanged for projects without
        //   mvp_scope)
        const cohort = state.release?.current_cut_id;

        // RFC §10 D-Q6 + Phase 1.4b: a cohort with FAILED TODOs MUST NOT be
        // recorded as completed. release-finalize would otherwise append the
        // cohort to `completed_cut_ids` (PR #185 codex review), flipping D-Q6
        // immutability on for a cohort that never actually shipped its release
        // artifact. The release path is reserved for cohorts whose sprint
        // completed cleanly.
        //
        // Codex re-review caught a follow-up: routing to phase3-gate here
        // would let an existing all-PASS state.gate_results path through to
        // phase5-finalize while the cohort is still active — whole-pipeline
        // finalize would start before the release path completes. Stay in
        // phase2-sprint instead until the FAILED TODOs are cleared in PLAN.md
        // (user/agent flips [FAILED] → [x] or removes the TODO). The release
        // path resumes naturally when the sprint completes cleanly.
        if (cohort && failed > 0) {
          console.log(JSON.stringify({
            continue: true,
            stopReason: `[MPL] Sprint resolved with FAILED TODOs (${completed} completed, ${failed} failed). ` +
              `Active release cohort "${cohort}" cannot enter the release path while failures are present, ` +
              `and routing to whole-pipeline phase3-gate would risk advancing past release-finalize when prior ` +
              `gate evidence is all-PASS. Staying in phase2-sprint. ` +
              `Clear the FAILED TODOs in PLAN.md (fix the failing tasks, then flip [FAILED] → [x]) to resume the release path.`
          }));
          break;
        }

        const nextPhase = cohort ? 'release-gate' : 'phase3-gate';
        const target = cohort ? `release-gate(${cohort})` : 'Phase 3: Quality Gate';
        writeState(cwd, { current_phase: nextPhase });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] All TODOs resolved (${completed} completed, ${failed} failed). Transitioning to ${target}.`
        }));
      } else {
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] Phase 2: Sprint in progress. ${completed}/${total} TODOs completed, ${failed} failed, ${remaining} remaining.`
        }));
      }
      break;
    }

    // === Stage A Release Path (Phase 1.6b stubs; 1.6c will add scoped Hard
    // 1/2/3 and release-manifest / artifact creation) ===

    case 'release-gate': {
      // Phase 1.6c-i: scoped Hard 1/2/3 evidence routing.
      //
      // Reads `state.release.gate_results` (parallel subtree to top-level
      // `state.gate_results`, per RFC §5.5 — scoped release evidence MUST
      // NOT mix into whole-pipeline gates reserved for the final
      // phase3-gate). mpl-gate-recorder populates this subtree only when
      // `current_phase == 'release-gate'`; this handler consumes and
      // routes. Evidence *production* (running scoped commands, deciding
      // affected-tests scope for Hard 2, etc.) is gate-recorder's
      // responsibility and lands separately.
      //
      // Routing per RFC §5.3.1:
      //   - PASS → release-finalize
      //   - FAIL → increment state.release.fix_loop_count, route back to
      //     phase2-sprint, PRESERVE current_cut_id. Reset scoped
      //     evidence so the next attempt starts clean.
      //   - FAIL at threshold (count reaches state.release.max_fix_loops,
      //     default 3) → circuit-break: pin cohort, stay at release-gate,
      //     surface user-actionable message. User intervention required.
      //   - MISSING → continue with stopReason guiding orchestrator to
      //     produce evidence; same UX as phase3-gate partial/empty paths.
      const cohort = state.release?.current_cut_id;
      if (!cohort) {
        // Defensive: release-gate without an active cohort is a state
        // corruption. Surface and revert to phase3-gate (whole-pipeline).
        writeState(cwd, { current_phase: 'phase3-gate' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL] ⚠ release-gate entered with no active cohort. Reverting to phase3-gate.'
        }));
        break;
      }

      // The workspace `missing_gate_evidence` rule only controls MISSING
      // message wording (in progress vs ⛔ BLOCKED) for parity with
      // phase3-gate UX. The strict toggle for checkGateResults is ALWAYS
      // true on release-gate, regardless of policy.
      //
      // Rationale (PR #186 codex/claude High #2): `state.release.gate_results`
      // is a v6 subtree with no historical legacy boolean evidence to
      // honor. The transitional zero-structured legacy fallback was added
      // for top-level state.gate_results to ease the AD-0006 migration; on
      // a brand-new subtree it would let `release.gate_results.hard1_passed
      // = true` alone trigger PASS → release-finalize, bypassing the
      // structured-only contract Phase 1.6c-i is meant to enforce.
      const releaseGateRuleAction = resolveRuleAction(cwd, state, 'missing_gate_evidence');
      const releaseMissingMessagingStrict = releaseGateRuleAction === 'block';
      // Adapter: checkGateResults reads `state.gate_results`. Wrap the
      // release subtree to reuse the structured-vs-legacy decision tree
      // without duplicating logic across two gate paths. `strict: true`
      // is hard-coded (see rationale above) — release-gate ALWAYS requires
      // structured exits.
      const releaseGates = state.release?.gate_results || {};
      const releaseResults = checkGateResults({ gate_results: releaseGates }, { strict: true });

      if (releaseResults.allPassed) {
        writeState(cwd, { current_phase: 'release-finalize' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] release-gate(${cohort}): scoped Hard 1/2/3 passed (source=${releaseResults.source}). Transitioning to release-finalize.`
        }));
        break;
      }

      if (releaseResults.anyFailed) {
        const existingRelease = state.release || {};
        const currentReleaseFix = typeof existingRelease.fix_loop_count === 'number'
          ? existingRelease.fix_loop_count
          : 0;
        const releaseMax = typeof existingRelease.max_fix_loops === 'number'
          ? existingRelease.max_fix_loops
          : 3;
        // Avoid runaway increment when already pinned at threshold —
        // repeated Stop ticks would otherwise grow the counter past the
        // cap (cosmetic but noisy in /mpl-status).
        const nextReleaseFix = currentReleaseFix >= releaseMax
          ? currentReleaseFix
          : currentReleaseFix + 1;
        const willCircuitBreak = nextReleaseFix >= releaseMax;

        if (willCircuitBreak) {
          // Pin cohort, stay at release-gate. Only write when the count
          // actually changed (skip writeState noise on repeat pinned ticks).
          if (nextReleaseFix !== currentReleaseFix) {
            writeState(cwd, {
              release: { ...existingRelease, fix_loop_count: nextReleaseFix },
            });
          }
          console.log(JSON.stringify({
            continue: true,
            stopReason: `[MPL] ⛔ release-gate(${cohort}) circuit-break: release-scoped fix loop ${nextReleaseFix}/${releaseMax} (RFC §5.3.1). ` +
              `Gate results: H1=${releaseResults.details.hard1}, H2=${releaseResults.details.hard2}, H3=${releaseResults.details.hard3}. ` +
              `Cohort pinned. User intervention required: fix the failing tasks and reset state.release.fix_loop_count via mpl_state_write, ` +
              `OR remove the cohort from goal-contract.yaml mvp_scope to abort the release path.`
          }));
          break;
        }

        // Budget remaining → route back to phase2-sprint. Reset scoped
        // evidence on retry so mpl-gate-recorder writes fresh exits on
        // the next attempt (same pattern as phase3-gate FAIL path).
        writeState(cwd, {
          current_phase: 'phase2-sprint',
          release: {
            ...existingRelease,
            fix_loop_count: nextReleaseFix,
            gate_results: {
              hard1_passed: null, hard2_passed: null, hard3_passed: null,
              hard1_baseline: null, hard2_coverage: null, hard3_resilience: null,
            },
          },
        });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] release-gate(${cohort}) FAILED (source=${releaseResults.source}). ` +
            `H1=${releaseResults.details.hard1}, H2=${releaseResults.details.hard2}, H3=${releaseResults.details.hard3}. ` +
            `Scoped fix loop ${nextReleaseFix}/${releaseMax}. Returning to phase2-sprint; cohort "${cohort}" preserved. ` +
            `Fix the failing tasks, then re-run scoped Hard 1/2/3 — mpl-gate-recorder will repopulate state.release.gate_results.`
        }));
        break;
      }

      // MISSING (zero or partial structured evidence). No transition;
      // surface guidance and let the orchestrator produce evidence. The
      // workspace strict policy changes the message wording only — the
      // structured-only contract is always enforced (see above).
      //
      // Note: `missingEvidence` is guaranteed non-empty here because
      // checkGateResults returns the MISSING branch only when at least
      // one of hard{1,2,3} is absent. The full-PASS path returns earlier.
      const missing = releaseResults.missingEvidence;
      const verb = releaseMissingMessagingStrict ? '⛔ BLOCKED' : 'in progress';
      const tail = releaseMissingMessagingStrict
        ? 'Strict enforcement requires all 3 scoped gates to be recorded by mpl-gate-recorder via real Bash exit codes. Self-reported booleans are not accepted.'
        : `Run the missing scoped gates so mpl-gate-recorder writes structured evidence into state.release.gate_results; the loop will continue once all 3 are recorded.`;
      console.log(JSON.stringify({
        continue: true,
        stopReason: `[MPL] release-gate(${cohort}) ${verb}: missing scoped Hard 1/2/3 evidence (${missing.join(', ')}). ${tail}`
      }));
      break;
    }

    case 'release-finalize': {
      // Phase 1.6c-ii: write release-manifest.json + evidence-summary.md +
      // gate-results.json under .mpl/mpl/releases/{cut_id}/ before the
      // existing append+clear step. RFC §5.4 requires the manifest write
      // to precede `completed_cut_ids` append — a cohort is only "released"
      // (and D-Q6 immutable) once its manifest is shipped.
      //
      // Snapshot identifiers (commit_sha/tree_sha/snapshot_ref) are
      // placeholders here; 1.6c-iii populates them via git rev-parse /
      // update-ref. Optional user-visible artifact creation (draft_pr /
      // branch / tag) also lands in 1.6c-iii. The manifest schema is
      // stable across the 1.6c-ii → 1.6c-iii boundary so the upcoming
      // diff is small.
      //
      // RFC §5.5 invariants preserved: this handler MUST NOT set
      // `state.finalize_done=true` and MUST NOT transition `current_phase`
      // to `completed`. Both remain exclusive to phase5-finalize.
      const cur = state.release?.current_cut_id;
      if (!cur) {
        writeState(cwd, { current_phase: 'phase3-gate' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: '[MPL] ⚠ release-finalize entered with no active cohort. Routing to phase3-gate.'
        }));
        break;
      }

      // Read contract + decomposition for the manifest builder. Both are
      // required: contract supplies goal_trace (AC/AX), decomposition
      // supplies phases per cut. Missing either is an actionable error —
      // refuse to write a degraded manifest and stay at release-finalize.
      //
      // PR #187 round-2 codex+claude High: an INVALID contract (e.g.,
      // `mvp_scope: { artifact: draft_pr }` with no AC/AX) was previously
      // passed through because the handler only checked `gcRead.exists`.
      // The validator already flags `mvp_scope.acceptance_criteria_or_variation_axes`
      // and other structural failures; route any `!gcRead.valid` through
      // the same bail mechanism so a degraded "released" manifest with
      // empty goal_trace cannot flip D-Q6 immutability. Library-layer
      // defense (resolveCutDescriptor rejecting empty AC+AX) is the
      // backstop for callers that bypass `readGoalContract`.
      const gcRead = readGoalContract(cwd);
      if (gcRead.exists && !gcRead.valid) {
        const reasonList = Array.isArray(gcRead.missing) && gcRead.missing.length > 0
          ? gcRead.missing.join(', ')
          : '(no detail)';
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] ⛔ release-finalize(${cur}): goal-contract is invalid (${reasonList}). ` +
            `Cohort NOT appended to completed_cut_ids. Fix .mpl/goal-contract.yaml — the validator at ` +
            `mpl-goal-contract.validateGoalContractText lists what is required. ` +
            `Staying at release-finalize until resolved.`
        }));
        break;
      }
      const contract = gcRead.exists ? gcRead.contract : null;
      let graph = null;
      try {
        const decompPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
        if (existsSync(decompPath)) {
          graph = parsePhaseContractGraphText(readFileSync(decompPath, 'utf-8'));
        }
      } catch {
        graph = null;
      }

      const writtenAt = new Date().toISOString();
      const manifest = buildReleaseManifest({ cutId: cur, state, contract, graph, now: writtenAt });
      if (!manifest) {
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] ⛔ release-finalize(${cur}): cohort descriptor missing from contract/decomposition. ` +
            `Cannot build release manifest. Verify .mpl/goal-contract.yaml mvp_scope and ` +
            `.mpl/mpl/decomposition.yaml mvp.phases are present and match the active cut_id. ` +
            `Staying at release-finalize until resolved.`
        }));
        break;
      }

      // Phase 1.6c-iii: create snapshot ref BEFORE writing the manifest so
      // commit_sha / tree_sha / snapshot_ref can be recorded. RFC §5.4.1:
      // "at the start of release-finalize(cut_id), before any artifact-
      // creation attempt". A snapshot-ref failure is a soft failure — the
      // manifest is still written (with placeholders) and the failure is
      // recorded in `artifact_creation_failed.snapshot` so the user has
      // an actionable record. The lifecycle still advances because RFC
      // §5.4 explicitly tolerates artifact creation depending on tools
      // out of MPL's control.
      const snapshot = createSnapshotRef(cwd, cur);
      if (snapshot.ok) {
        manifest.commit_sha = snapshot.commit_sha;
        manifest.tree_sha = snapshot.tree_sha;
        manifest.snapshot_ref = snapshot.snapshot_ref;
      } else {
        manifest.artifact_creation_failed = { type: 'snapshot_ref', reason: snapshot.reason };
      }

      const evidence = buildEvidenceSummary({ cutId: cur, state, contract, graph, now: writtenAt });
      const gateSnapshot = buildGateResultsSnapshot(state, writtenAt);

      const releaseDir = join(cwd, RELEASE_DIR_REL_PATH, cur);
      const manifestPath = join(releaseDir, 'release-manifest.json');
      try {
        mkdirSync(releaseDir, { recursive: true });
        // 0o644 (not the 0o600 used for state.json): release artifacts
        // are designed for consumption by CI runners, mpl-status, and
        // future tooling that may run as a different uid on a shared
        // dev box / CI agent (claude review #1 on PR #187). state.json
        // stays 0o600 because it carries session-internal evidence;
        // these files are the shippable record of the release.
        //
        // Atomic temp+rename (claude review #2 on PR #187) so a mid-write
        // failure leaves the on-disk state at the prior generation
        // instead of an asymmetric "manifest written but summary
        // missing" state.
        atomicWriteFile(
          manifestPath,
          JSON.stringify(manifest, null, 2) + '\n',
          0o644
        );
        atomicWriteFile(
          join(releaseDir, 'evidence-summary.md'),
          evidence.endsWith('\n') ? evidence : evidence + '\n',
          0o644
        );
        atomicWriteFile(
          join(releaseDir, 'gate-results.json'),
          JSON.stringify(gateSnapshot, null, 2) + '\n',
          0o644
        );
      } catch (err) {
        // Manifest write failure must NOT advance the lifecycle (RFC §5.4:
        // append only after manifest write succeeds). Surface and pin.
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] ⛔ release-finalize(${cur}): manifest write failed (${err?.message || 'unknown'}). ` +
            `Cohort NOT appended to completed_cut_ids. Resolve the filesystem error under ` +
            `${RELEASE_DIR_REL_PATH}/${cur}/ and let the loop retry.`
        }));
        break;
      }

      // Phase 1.6c-iii: attempt user-visible artifact (tag / branch /
      // draft_pr) after manifest write succeeded. Only run when snapshot
      // ref creation succeeded — without commit_sha we cannot point an
      // artifact at the cut's terminal commit. The attempt is best-
      // effort per RFC §5.4: failures are recorded in the manifest
      // (artifact_creation_failed) and surfaced to the user, but they do
      // NOT block `completed_cut_ids` append because artifact creation
      // depends on external tools (gh CLI, remote permissions) that are
      // out of MPL's control.
      let artifactAttempt = null;
      if (snapshot.ok && manifest.artifact && manifest.artifact !== 'release_manifest') {
        artifactAttempt = attemptArtifactCreation({
          cwd,
          cutId: cur,
          artifact: manifest.artifact,
          commitSha: snapshot.commit_sha,
          snapshotRef: snapshot.snapshot_ref,
        });
        if (artifactAttempt.artifact_creation_failed) {
          // Re-write the manifest with the failure recorded so the
          // shipped record matches the actual outcome.
          manifest.artifact_creation_failed = artifactAttempt.artifact_creation_failed;
          try {
            atomicWriteFile(
              manifestPath,
              JSON.stringify(manifest, null, 2) + '\n',
              0o644
            );
          } catch {
            // Manifest re-write failure is itself non-fatal — the
            // original manifest (with artifact_creation_failed=null) is
            // already on disk; the lifecycle should still advance to
            // honor the "best-effort post-step" contract.
          }
        }
      }

      const existing = state.release || {};
      const already = Array.isArray(existing.completed_cut_ids) ? existing.completed_cut_ids : [];
      const completed = already.includes(cur) ? already : [...already, cur];

      // Stage A simplification: decomposer (Phase 1.2 / PR #182) emits
      // `release_cuts: []` so there is never a "next cut" to advance to.
      // The orchestrator routes directly to whole-pipeline phase3-gate.
      // Multi-cohort cut chaining (auto-proposed extension cuts) is RFC
      // §10 D-Q2 Stage B work.
      const nextCutId = null;
      const nextPhase = 'phase3-gate';

      writeState(cwd, {
        release: {
          ...existing,
          completed_cut_ids: completed,
          current_cut_id: nextCutId,
          fix_loop_count: 0,
        },
        current_phase: nextPhase,
      });
      // Build a status-aware tail so users immediately see whether the
      // snapshot/artifact step succeeded or fell back.
      const snapshotTail = snapshot.ok
        ? `snapshot ${snapshot.snapshot_ref} @ ${snapshot.commit_sha.slice(0, 12)}`
        : `⚠ snapshot ref FAILED (${snapshot.reason}) — artifact_creation_failed recorded`;
      const artifactTail = (() => {
        if (!manifest.artifact || manifest.artifact === 'release_manifest') return 'artifact=release_manifest (no external push)';
        if (!artifactAttempt) return `artifact=${manifest.artifact} skipped (snapshot ref failed)`;
        if (artifactAttempt.artifact_creation_failed) {
          return `⚠ artifact=${manifest.artifact} FAILED (${artifactAttempt.artifact_creation_failed.reason})`;
        }
        return `artifact=${manifest.artifact} created`;
      })();
      console.log(JSON.stringify({
        continue: true,
        stopReason: `[MPL] release-finalize(${cur}): cohort completed. Manifest written to ${RELEASE_DIR_REL_PATH}/${cur}/. ` +
          `${snapshotTail}. ${artifactTail}. ` +
          `Stage A single-cohort path: transitioning to whole-pipeline phase3-gate.`
      }));
      break;
    }

    case 'phase3-gate': {
      // Stage A defense-in-depth (RFC §5.5): the whole-pipeline phase3-gate
      // must never advance to phase5-finalize while a release cohort is
      // still active. Any prior all-PASS gate_results from a previous run
      // would otherwise let an in-progress release path's finalize be
      // skipped. Sprint completion routing already prevents this in normal
      // flow (failed-cohort case stays in phase2-sprint; clean-cohort case
      // routes to release-gate), but a hand-edited state.json or a
      // recompose-driven re-entry could still land here with a live cohort.
      // Surface and revert.
      if (state.release?.current_cut_id) {
        writeState(cwd, { current_phase: 'phase2-sprint' });
        console.log(JSON.stringify({
          continue: true,
          stopReason: `[MPL] ⚠ phase3-gate entered while release cohort "${state.release.current_cut_id}" is still active. ` +
            `Whole-pipeline finalize must NOT run before release-finalize completes the active cohort. ` +
            `Reverting to phase2-sprint; complete the cohort's release path first (release-gate → release-finalize).`
        }));
        break;
      }

      // Per-rule policy (P0-2, #110): `missing_gate_evidence` resolves the
      // strict toggle for checkGateResults. Default is 'warn' per #110 §정책
      // (transitional — surface only, no block). Workspace can opt-in to
      // 'block' to halt phase3-gate transitions until mpl-gate-recorder writes
      // structured exits, or 'off' to suppress the legacy fallback ⚠ entirely.
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
      // RFC §10 D-Q7: small-pipeline and `mvp_scope` are mutually exclusive.
      // Small-pipeline answers "the whole task is small, run a lightweight
      // pipeline." MVP cut answers "the task is large, ship a subset first."
      // Conflating the two doubles the state-machine complexity for marginal
      // gain. When mvp_scope is declared, the project MUST take the full MPL
      // pipeline with the release path; small-pipeline entry is rejected
      // here rather than silently downgrading the contract.
      const gc = readGoalContract(cwd);
      if (gc.exists && gc.contract?.mvp_scope) {
        console.log(JSON.stringify({
          continue: false,
          decision: 'block',
          reason: '[MPL] small-pipeline is not available when goal_contract.mvp_scope is declared. ' +
            'Use the full MPL pipeline so the Stage A release path (release-gate → release-finalize) ' +
            'can deliver the user-declared MVP cohort. ' +
            'Either run the full pipeline (recommended) or remove mvp_scope from .mpl/goal-contract.yaml and re-enter small-plan.'
        }));
        break;
      }

      // Small Plan: orchestrator handles, no auto-transition
      console.log(JSON.stringify({
        continue: true,
        stopReason: '[MPL-Small] Phase 1: Small Plan in progress. Complete planning and HITL before proceeding.'
      }));
      break;
    }

    case 'small-sprint': {
      // D-Q7 guard intentionally fires only at `case 'small-plan'`. If a
      // user lands here after entering small-plan with mvp_scope absent
      // (legitimate path), the contract may have been edited mid-flow to
      // add mvp_scope. Re-checking here is *not* supported in Phase 1.6a
      // — the cost is replicating the guard in three places (-sprint,
      // -verify) for an edge case where the user is intentionally
      // restructuring mid-pipeline. Recommended workflow for that case:
      // cancel the small pipeline and restart with the full pipeline.
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
