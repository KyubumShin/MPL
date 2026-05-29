/**
 * Whole-goal closure validation.
 *
 * Finalization must prove that completed phase evidence covers the frozen Goal
 * Contract, not merely that some artifacts exist.
 *
 * #241 B4 (delivered via #248): when an active release cohort opts into
 * `complete_pipeline_optional: true` (either on the cohort object in
 * `state.release.cohort.complete_pipeline_optional` or workspace-wide
 * via `.mpl/config.json:release.complete_pipeline_optional`), the
 * closure check is scoped to the cohort's declared phases instead of
 * every decomposition phase. This unblocks the intentional partial-MVP
 * release pattern where a cohort is shipped while non-cohort phases
 * remain open for a later `mpl-run`.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { completedPhaseIds } from './mpl-completed-phase-immutability.mjs';
import { parseDecompositionGoalTraceText } from './mpl-goal-trace.mjs';
import { validatePhaseEvidenceFile } from './mpl-phase-evidence.mjs';
import { loadConfig } from './mpl-config.mjs';

function difference(required, actual) {
  const actualSet = new Set(actual);
  return required.filter((id) => !actualSet.has(id));
}

export function readDecompositionGoalTrace(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(path)) return null;
  return parseDecompositionGoalTraceText(readFileSync(path, 'utf-8'));
}

/**
 * Return the active cohort's phase id list when `complete_pipeline_optional`
 * is enabled and a cohort is in scope, otherwise null.
 *
 * Precedence (consistent with other config readers):
 *   state.release.cohort.complete_pipeline_optional (true) >
 *   workspace .mpl/config.json:release.complete_pipeline_optional (true).
 *
 * A truthy flag without a cohort or without a non-empty `cohort.phases`
 * list returns null — the check falls back to the full-decomposition
 * path because there is no smaller-than-whole scope to enforce.
 */
export function resolveCohortScope({ cwd, state = {} } = {}) {
  const cohort = state?.release?.cohort;
  if (!cohort || !Array.isArray(cohort.phases) || cohort.phases.length === 0) {
    return null;
  }
  let optional = cohort.complete_pipeline_optional === true;
  if (!optional && cwd) {
    try {
      const cfg = loadConfig(cwd) || {};
      optional = cfg?.release?.complete_pipeline_optional === true;
    } catch {
      /* fail-soft: config unreadable → treat as not opted in */
    }
  }
  if (!optional) return null;
  return cohort.phases;
}

export function validateWholeGoalClosure({ cwd, state = {}, contract = null }) {
  const issues = [];
  const decomposition = readDecompositionGoalTrace(cwd);
  if (!decomposition || !Array.isArray(decomposition.phases) || decomposition.phases.length === 0) {
    return { valid: false, issues: ['decomposition:missing'] };
  }

  const cohortPhaseIds = resolveCohortScope({ cwd, state });
  const decompPhaseIdSet = new Set(decomposition.phases.map((p) => p.id));
  const scopedPhases = cohortPhaseIds
    ? decomposition.phases.filter((p) => cohortPhaseIds.includes(p.id))
    : decomposition.phases;

  // Codex r1 [logic] fix: fail closed when ANY cohort phase id is
  // absent from decomposition, not only when the entire cohort is
  // missing. A partially-stale cohort descriptor (1 of N ids has been
  // recomposed away) would otherwise have its missing id silently
  // dropped, narrowing the required universe and letting the closure
  // pass on a corrupted cohort definition.
  if (cohortPhaseIds) {
    const missingCohortIds = cohortPhaseIds.filter((id) => !decompPhaseIdSet.has(id));
    if (missingCohortIds.length > 0) {
      return {
        valid: false,
        issues: [
          `cohort:phases_not_in_decomposition:${missingCohortIds.join(',')}`,
        ],
        cohort_scoped: true,
        scoped_phase_ids: scopedPhases.map((p) => p.id),
      };
    }
  }

  const completed = new Set(completedPhaseIds(cwd, state));
  const scopedPhaseIds = scopedPhases.map((phase) => phase.id);
  const completedAc = [];
  const completedAx = [];

  const declaredCompleted = state?.execution?.phases?.completed;
  // When cohort-scoped, the declared-completed sanity is against the
  // cohort size; when whole-pipeline, against the full decomposition.
  if (Number.isInteger(declaredCompleted) && !cohortPhaseIds) {
    if (declaredCompleted !== decomposition.phases.length) {
      issues.push(`execution.phases.completed:expected:${decomposition.phases.length}:actual:${declaredCompleted}`);
    }
  }

  for (const phase of scopedPhases) {
    if (!completed.has(phase.id)) {
      issues.push(`${phase.id}:not_completed`);
      continue;
    }
    const evidence = validatePhaseEvidenceFile(cwd, phase.id, state);
    issues.push(...evidence.issues);
    completedAc.push(...(phase.acceptance_criteria || []));
    completedAx.push(...(phase.variation_axes || []));
  }

  // When cohort-scoped, the Goal Contract closure narrows to the AC/AX
  // ids the cohort phases were declared to cover. Phase entries the
  // cohort did not include can carry uncovered AC/AX ids without
  // blocking the cohort's partial-MVP finalize.
  const cohortAcUniverse = cohortPhaseIds
    ? new Set(scopedPhases.flatMap((p) => p.acceptance_criteria || []))
    : null;
  const cohortAxUniverse = cohortPhaseIds
    ? new Set(scopedPhases.flatMap((p) => p.variation_axes || []))
    : null;

  if (contract) {
    const acRequirement = cohortPhaseIds
      ? (contract.acceptance_criteria || []).filter((id) => cohortAcUniverse.has(id))
      : contract.acceptance_criteria || [];
    const axRequirement = cohortPhaseIds
      ? (contract.variation_axes || []).filter((id) => cohortAxUniverse.has(id))
      : contract.variation_axes || [];
    for (const id of difference(acRequirement, completedAc)) {
      issues.push(`acceptance_criteria:not_completed:${id}`);
    }
    for (const id of difference(axRequirement, completedAx)) {
      issues.push(`variation_axes:not_completed:${id}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    cohort_scoped: cohortPhaseIds != null,
    scoped_phase_ids: scopedPhaseIds,
  };
}
