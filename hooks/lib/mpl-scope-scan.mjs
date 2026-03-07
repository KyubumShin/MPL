#!/usr/bin/env node
/**
 * MPL Scope Scan Utility (F-20: Adaptive Pipeline Router)
 *
 * Calculates pipeline_score and classifies pipeline_tier.
 * Used by Triage (Step 0) to determine which pipeline variant to run.
 *
 * Score formula:
 *   pipeline_score = (file_scope × 0.35) + (test_complexity × 0.25)
 *                  + (dependency_depth × 0.25) + (risk_signal × 0.15)
 *
 * Tier thresholds:
 *   < 0.3   → frugal  (≈ mpl-bugfix: single fix cycle)
 *   0.3~0.65 → standard (≈ mpl-small extended: single phase)
 *   > 0.65  → frontier (full 9+ step pipeline)
 *
 * Reference: Ouroboros PAL Router (src/ouroboros/routing/)
 */

/**
 * Calculate pipeline score from scan results
 * @param {object} scan - Quick Scope Scan results
 * @param {number} scan.affected_files - Estimated number of affected files
 * @param {number} scan.test_scenarios - Number of test scenarios needed
 * @param {number} scan.import_depth - Max import chain depth
 * @param {number} scan.risk_signal - Risk signal from keywords (0.0~1.0)
 * @returns {{ score: number, breakdown: object }}
 */
export function calculatePipelineScore(scan) {
  const fileScope = Math.min((scan.affected_files || 0) / 10, 1.0);
  const testComplexity = Math.min((scan.test_scenarios || 0) / 8, 1.0);
  const dependencyDepth = Math.min((scan.import_depth || 0) / 5, 1.0);
  const riskSignal = Math.min(Math.max(scan.risk_signal || 0, 0), 1.0);

  const score =
    fileScope * 0.35 +
    testComplexity * 0.25 +
    dependencyDepth * 0.25 +
    riskSignal * 0.15;

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
 * Classify tier from score, with optional hint override
 * @param {number} score - Pipeline score (0.0~1.0)
 * @param {string|null} hint - User hint: "frugal", "standard", or null (auto)
 * @returns {{ tier: string, source: string }}
 */
export function classifyTier(score, hint = null) {
  if (hint && ['frugal', 'standard', 'frontier'].includes(hint)) {
    return { tier: hint, source: 'hint' };
  }

  if (score < 0.3) return { tier: 'frugal', source: 'auto' };
  if (score <= 0.65) return { tier: 'standard', source: 'auto' };
  return { tier: 'frontier', source: 'auto' };
}

/**
 * Extract risk signal from user prompt keywords
 * @param {string} prompt - User prompt text
 * @returns {number} Risk signal (0.0~1.0)
 */
export function extractRiskSignal(prompt) {
  const lower = prompt.toLowerCase();

  // Low risk keywords → frugal direction
  if (/\b(fix|bug|typo|수정|오류|rename|config)\b/.test(lower)) return 0.1;
  // Medium-low → standard direction
  if (/\b(add|update|field|변경|추가|small|간단)\b/.test(lower)) return 0.3;
  // Medium → standard/frontier boundary
  if (/\b(feature|기능|implement|구현|create|생성)\b/.test(lower)) return 0.5;
  // High → frontier direction
  if (/\b(refactor|리팩토링|migrate|마이그레이션|architecture|아키텍처|redesign|재설계)\b/.test(lower)) return 0.8;
  // Very high
  if (/\b(overhaul|rewrite|전면)\b/.test(lower)) return 0.95;

  return 0.4; // default: moderate
}

/**
 * Extract tier hint from user prompt keywords (used by keyword-detector)
 * @param {string} prompt - User prompt text
 * @returns {string|null} "frugal", "standard", or null
 */
export function extractTierHint(prompt) {
  const lower = prompt.toLowerCase();
  if (/\bmpl[\s-]*(bugfix|fix|bug)\b/i.test(lower)) return 'frugal';
  if (/\bmpl[\s-]*(small|quick|light)\b/i.test(lower)) return 'standard';
  return null;
}

/**
 * Format scan evidence for logging
 * @param {object} scan - Scan results
 * @param {number} score - Pipeline score
 * @param {string} tier - Selected tier
 * @param {string} source - Tier source ("auto" or "hint")
 * @returns {string} Formatted evidence string
 */
export function formatScanEvidence(scan, score, tier, source) {
  const parts = [
    `score=${score.toFixed(3)}`,
    `tier=${tier}`,
    `source=${source}`,
    `files=${scan.affected_files || 0}`,
    `tests=${scan.test_scenarios || 0}`,
    `depth=${scan.import_depth || 0}`,
    `risk=${(scan.risk_signal || 0).toFixed(2)}`,
  ];
  return parts.join(', ');
}
