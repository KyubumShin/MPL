/**
 * Whole-goal closure validation.
 *
 * Finalization must prove that completed phase evidence covers the frozen Goal
 * Contract, not merely that some artifacts exist.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { completedPhaseIds } from './mpl-completed-phase-immutability.mjs';
import { parseDecompositionGoalTraceText } from './mpl-goal-trace.mjs';
import { validatePhaseEvidenceFile } from './mpl-phase-evidence.mjs';

function difference(required, actual) {
  const actualSet = new Set(actual);
  return required.filter((id) => !actualSet.has(id));
}

export function readDecompositionGoalTrace(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(path)) return null;
  return parseDecompositionGoalTraceText(readFileSync(path, 'utf-8'));
}

export function validateWholeGoalClosure({ cwd, state = {}, contract = null }) {
  const issues = [];
  const decomposition = readDecompositionGoalTrace(cwd);
  if (!decomposition || !Array.isArray(decomposition.phases) || decomposition.phases.length === 0) {
    return { valid: false, issues: ['decomposition:missing'] };
  }

  const completed = new Set(completedPhaseIds(cwd, state));
  const phaseIds = decomposition.phases.map((phase) => phase.id);
  const completedAc = [];
  const completedAx = [];

  const declaredCompleted = state?.execution?.phases?.completed;
  if (Number.isInteger(declaredCompleted) && declaredCompleted !== phaseIds.length) {
    issues.push(`execution.phases.completed:expected:${phaseIds.length}:actual:${declaredCompleted}`);
  }

  for (const phase of decomposition.phases) {
    if (!completed.has(phase.id)) {
      issues.push(`${phase.id}:not_completed`);
      continue;
    }
    const evidence = validatePhaseEvidenceFile(cwd, phase.id, state);
    issues.push(...evidence.issues);
    completedAc.push(...(phase.acceptance_criteria || []));
    completedAx.push(...(phase.variation_axes || []));
  }

  if (contract) {
    for (const id of difference(contract.acceptance_criteria || [], completedAc)) {
      issues.push(`acceptance_criteria:not_completed:${id}`);
    }
    for (const id of difference(contract.variation_axes || [], completedAx)) {
      issues.push(`variation_axes:not_completed:${id}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
