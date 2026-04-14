#!/usr/bin/env node
/**
 * MPL Scope Scan Utility (Hat Model: PP-Proximity)
 *
 * Calculates pp_score and classifies pp_proximity.
 * Used by Triage (Step 0) to determine pipeline scope.
 *
 * Score formula:
 *   pp_score = (file_scope × 0.35) + (test_complexity × 0.25)
 *            + (dependency_depth × 0.25) + (risk_signal × 0.15)
 *
 * PP-Proximity thresholds:
 *   < 0.3   → near  (close to pivot point: minimal pipeline)
 *   0.3~0.65 → mid  (moderate distance: standard pipeline)
 *   > 0.65  → far   (far from pivot point: full pipeline)
 *
 * Reference: Ouroboros PAL Router (src/ouroboros/routing/)
 */

/**
 * Default weights for pipeline score calculation.
 * Can be overridden via config (hat section) or per-task interview.
 */
const DEFAULT_WEIGHTS = {
  file_scope: 0.35,
  test_complexity: 0.25,
  dependency_depth: 0.25,
  risk_signal: 0.15,
};

/**
 * Calculate pipeline score from scan results
 * @param {object} scan - Quick Scope Scan results
 * @param {number} scan.affected_files - Estimated number of affected files
 * @param {number} scan.test_scenarios - Number of test scenarios needed
 * @param {number} scan.import_depth - Max import chain depth
 * @param {number} scan.risk_signal - Risk signal from keywords (0.0~1.0)
 * @param {object|null} weights - Optional weight overrides { file_scope, test_complexity, dependency_depth, risk_signal }
 * @returns {{ score: number, breakdown: object }}
 */
export function calculatePipelineScore(scan, weights = null) {
  const fileScope = Math.min((scan.affected_files || 0) / 10, 1.0);
  const testComplexity = Math.min((scan.test_scenarios || 0) / 8, 1.0);
  const dependencyDepth = Math.min((scan.import_depth || 0) / 5, 1.0);
  const riskSignal = Math.min(Math.max(scan.risk_signal || 0, 0), 1.0);

  // Use provided weights with fallback to defaults
  let w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };

  // Normalize if weights don't sum to 1.0
  const sum = w.file_scope + w.test_complexity + w.dependency_depth + w.risk_signal;
  if (Math.abs(sum - 1.0) > 0.001) {
    w.file_scope /= sum;
    w.test_complexity /= sum;
    w.dependency_depth /= sum;
    w.risk_signal /= sum;
  }

  const score =
    fileScope * w.file_scope +
    testComplexity * w.test_complexity +
    dependencyDepth * w.dependency_depth +
    riskSignal * w.risk_signal;

  return {
    score: Math.round(score * 1000) / 1000,
    breakdown: {
      file_scope: Math.round(fileScope * 1000) / 1000,
      test_complexity: Math.round(testComplexity * 1000) / 1000,
      dependency_depth: Math.round(dependencyDepth * 1000) / 1000,
      risk_signal: Math.round(riskSignal * 1000) / 1000,
    },
  };
}

/**
 * Classify PP-proximity from score, with optional hint override
 * @param {number} score - PP score (0.0~1.0)
 * @param {string|null} hint - User hint: "near", "mid", or null (auto)
 * @returns {{ proximity: string, source: string }}
 */
export function classifyProximity(score, hint = null) {
  if (hint && ['near', 'mid', 'far'].includes(hint)) {
    return { proximity: hint, source: 'hint' };
  }

  if (score < 0.3) return { proximity: 'near', source: 'auto' };
  if (score <= 0.65) return { proximity: 'mid', source: 'auto' };
  return { proximity: 'far', source: 'auto' };
}

/**
 * Extract risk signal from user prompt keywords
 * @param {string} prompt - User prompt text
 * @returns {number} Risk signal (0.0~1.0)
 */
export function extractRiskSignal(prompt) {
  const lower = prompt.toLowerCase();

  // Low risk keywords → near PP direction
  if (/\b(fix|bug|typo|수정|오류|rename|config)\b/.test(lower)) return 0.1;
  // Medium-low → mid PP direction
  if (/\b(add|update|field|변경|추가|small|간단)\b/.test(lower)) return 0.3;
  // Medium → mid/far boundary
  if (/\b(feature|기능|implement|구현|create|생성)\b/.test(lower)) return 0.5;
  // High → far PP direction
  if (/\b(refactor|리팩토링|migrate|마이그레이션|architecture|아키텍처|redesign|재설계)\b/.test(lower)) return 0.8;
  // Very high
  if (/\b(overhaul|rewrite|전면)\b/.test(lower)) return 0.95;

  return 0.4; // default: moderate
}

/**
 * Extract PP-proximity hint from user prompt keywords (used by keyword-detector)
 * @param {string} prompt - User prompt text
 * @returns {string|null} "near", "mid", or null
 */
export function extractProximityHint(prompt) {
  const lower = prompt.toLowerCase();
  if (/\bmpl[\s-]*(bugfix|fix|bug)\b/i.test(lower)) return 'near';
  if (/\bmpl[\s-]*(small|quick|light)\b/i.test(lower)) return 'mid';
  return null;
}

/**
 * Format scan evidence for logging
 * @param {object} scan - Scan results
 * @param {number} score - PP score
 * @param {string} proximity - Selected PP-proximity
 * @param {string} source - Proximity source ("auto" or "hint")
 * @returns {string} Formatted evidence string
 */
export function formatScanEvidence(scan, score, proximity, source) {
  const parts = [
    `pp_score=${score.toFixed(3)}`,
    `proximity=${proximity}`,
    `source=${source}`,
    `files=${scan.affected_files || 0}`,
    `tests=${scan.test_scenarios || 0}`,
    `depth=${scan.import_depth || 0}`,
    `risk=${(scan.risk_signal || 0).toFixed(2)}`,
  ];
  return parts.join(', ');
}
