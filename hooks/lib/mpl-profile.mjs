/**
 * MPL Token Profile Analyzer
 *
 * Parses phases.jsonl and run-summary.json to produce aggregate statistics,
 * anomaly detection, and text-based reports.
 *
 * Profile directory: .mpl/mpl/profile/
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const PROFILE_DIR = '.mpl/mpl/profile';
const PHASES_FILE = 'phases.jsonl';
const SUMMARY_FILE = 'run-summary.json';

/**
 * Parse a JSONL file into an array of objects.
 *
 * @param {string} filePath - Path to JSONL file
 * @returns {object[]} Parsed entries
 */
export function parseJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Analyze profile data from phases.jsonl.
 *
 * @param {string} cwd - Project root directory
 * @returns {object} Analysis result with totals, per-phase stats, and anomalies
 */
export function analyzeProfile(cwd) {
  const phasesPath = join(cwd, PROFILE_DIR, PHASES_FILE);
  const entries = parseJsonl(phasesPath);

  if (entries.length === 0) {
    return { phases: [], totals: null, anomalies: [] };
  }

  // Per-phase stats
  const phases = entries.map(e => ({
    step: e.step || 'unknown',
    name: e.name || '',
    pass_rate: e.pass_rate ?? null,
    micro_fixes: e.micro_fixes ?? 0,
    retries: e.retries ?? 0,
    tokens: e.estimated_tokens?.total ?? 0,
    context_tokens: e.estimated_tokens?.context ?? 0,
    output_tokens: e.estimated_tokens?.output ?? 0,
    duration_ms: e.duration_ms ?? 0,
  }));

  // Totals
  const totalTokens = phases.reduce((sum, p) => sum + p.tokens, 0);
  const totalDuration = phases.reduce((sum, p) => sum + p.duration_ms, 0);
  const totalMicroFixes = phases.reduce((sum, p) => sum + p.micro_fixes, 0);
  const totalRetries = phases.reduce((sum, p) => sum + p.retries, 0);
  const avgTokens = phases.length > 0 ? totalTokens / phases.length : 0;

  const totals = {
    phases: phases.length,
    tokens: totalTokens,
    duration_ms: totalDuration,
    micro_fixes: totalMicroFixes,
    retries: totalRetries,
    avg_tokens_per_phase: Math.round(avgTokens),
  };

  // Anomaly detection
  const anomalies = detectAnomalies(phases, avgTokens);

  return { phases, totals, anomalies };
}

/**
 * Detect anomalies in phase profile data.
 *
 * @param {object[]} phases - Per-phase stats
 * @param {number} avgTokens - Average tokens per phase
 * @returns {object[]} List of anomalies with severity and description
 */
export function detectAnomalies(phases, avgTokens) {
  const anomalies = [];

  for (const phase of phases) {
    // Token overuse: >2x average
    if (avgTokens > 0 && phase.tokens > avgTokens * 2) {
      anomalies.push({
        severity: 'warning',
        phase: phase.step,
        type: 'token_overuse',
        description: `${phase.step} used ${phase.tokens} tokens (${(phase.tokens / avgTokens).toFixed(1)}x average)`,
      });
    }

    // Excessive micro-fixes: 5+
    if (phase.micro_fixes >= 5) {
      anomalies.push({
        severity: 'warning',
        phase: phase.step,
        type: 'excessive_fixes',
        description: `${phase.step} required ${phase.micro_fixes} micro-fixes (threshold: 5)`,
      });
    }

    // Low pass rate
    if (phase.pass_rate !== null && phase.pass_rate < 80) {
      anomalies.push({
        severity: 'error',
        phase: phase.step,
        type: 'low_pass_rate',
        description: `${phase.step} pass rate ${phase.pass_rate}% (below 80% threshold)`,
      });
    }
  }

  return anomalies;
}

/**
 * Read run-summary.json if available.
 *
 * @param {string} cwd - Project root directory
 * @returns {object|null} Run summary or null
 */
export function readRunSummary(cwd) {
  const summaryPath = join(cwd, PROFILE_DIR, SUMMARY_FILE);
  if (!existsSync(summaryPath)) return null;
  try {
    return JSON.parse(readFileSync(summaryPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Format analysis results as a text report.
 *
 * @param {object} analysis - Output of analyzeProfile()
 * @param {object|null} summary - Output of readRunSummary()
 * @returns {string} Formatted text report
 */
export function formatReport(analysis, summary = null) {
  const lines = [];
  lines.push('=== MPL Token Profile Report ===');
  lines.push('');

  if (!analysis.totals) {
    lines.push('No profile data found.');
    return lines.join('\n');
  }

  // Summary section
  if (summary) {
    lines.push(`Run ID:      ${summary.run_id || 'N/A'}`);
    lines.push(`Complexity:  ${summary.complexity?.grade || 'N/A'} (score: ${summary.complexity?.score ?? 'N/A'})`);
    lines.push(`Cache:       ${summary.cache?.phase0_hit ? 'HIT' : 'MISS'} (saved: ${summary.cache?.saved_tokens ?? 0} tokens)`);
    lines.push('');
  }

  // Totals
  const t = analysis.totals;
  lines.push(`Phases:       ${t.phases}`);
  lines.push(`Total Tokens: ${t.tokens.toLocaleString()}`);
  lines.push(`Avg/Phase:    ${t.avg_tokens_per_phase.toLocaleString()}`);
  lines.push(`Duration:     ${(t.duration_ms / 1000).toFixed(1)}s`);
  lines.push(`Micro-fixes:  ${t.micro_fixes}`);
  lines.push(`Retries:      ${t.retries}`);
  lines.push('');

  // Per-phase table
  lines.push('--- Per-Phase Breakdown ---');
  lines.push(`${'Phase'.padEnd(15)} ${'Tokens'.padStart(8)} ${'Pass%'.padStart(6)} ${'Fixes'.padStart(6)} ${'Time'.padStart(8)}`);
  lines.push('-'.repeat(45));
  for (const p of analysis.phases) {
    const passStr = p.pass_rate !== null ? `${p.pass_rate}%` : 'N/A';
    const timeStr = `${(p.duration_ms / 1000).toFixed(1)}s`;
    lines.push(`${p.step.padEnd(15)} ${String(p.tokens).padStart(8)} ${passStr.padStart(6)} ${String(p.micro_fixes).padStart(6)} ${timeStr.padStart(8)}`);
  }
  lines.push('');

  // Anomalies
  if (analysis.anomalies.length > 0) {
    lines.push('--- Anomalies ---');
    for (const a of analysis.anomalies) {
      const icon = a.severity === 'error' ? '[ERROR]' : '[WARN] ';
      lines.push(`${icon} ${a.description}`);
    }
  } else {
    lines.push('No anomalies detected.');
  }

  return lines.join('\n');
}
