/**
 * MPL Session Budget Predictor (F-33)
 * Estimates whether remaining phases fit in the current context window.
 *
 * Data sources:
 *   - .mpl/context-usage.json (written by HUD every ~500ms)
 *   - .mpl/mpl/profile/phases.jsonl (historical token usage)
 *   - .mpl/mpl/decomposition.yaml (total phase count)
 *   - .mpl/state.json (completed phase tracking)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const DEFAULT_TOKENS_PER_PHASE = 15000; // conservative estimate
const SAFETY_MARGIN = 1.15; // 15% buffer
const STALE_THRESHOLD_MS = 30000; // 30s — context-usage.json freshness
const CRITICAL_REMAINING_PCT = 10; // below this = pause_now regardless

/**
 * Read context usage written by HUD.
 * @returns {{ pct: number, total_tokens: number, used_tokens: number, timestamp: number } | null}
 */
function readContextUsage(cwd) {
  try {
    const p = join(cwd, '.mpl', 'context-usage.json');
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    if (typeof data.pct !== 'number') return null;
    return data;
  } catch { return null; }
}

/**
 * Read historical avg tokens per phase from profile data.
 * @returns {number} average tokens per phase, or default if unavailable
 */
function readAvgTokensPerPhase(cwd) {
  try {
    const p = join(cwd, '.mpl', 'mpl', 'profile', 'phases.jsonl');
    if (!existsSync(p)) return DEFAULT_TOKENS_PER_PHASE;

    const lines = readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return DEFAULT_TOKENS_PER_PHASE;

    let totalTokens = 0;
    let count = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.tokens && entry.tokens > 0) {
          totalTokens += entry.tokens;
          count++;
        }
      } catch { /* skip invalid lines */ }
    }

    return count > 0 ? Math.round(totalTokens / count) : DEFAULT_TOKENS_PER_PHASE;
  } catch { return DEFAULT_TOKENS_PER_PHASE; }
}

/**
 * Count total phases from decomposition.
 * @returns {number} total phase count
 */
function readTotalPhases(cwd) {
  try {
    const p = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
    if (!existsSync(p)) return 0;
    const content = readFileSync(p, 'utf-8');
    // Count phase entries: lines matching "- id:" or "  - id:" pattern
    const matches = content.match(/^\s*-\s*id:/gm);
    return matches ? matches.length : 0;
  } catch { return 0; }
}

/**
 * Count completed phases from state.
 * @returns {number}
 */
function readCompletedPhases(cwd) {
  try {
    const p = join(cwd, '.mpl', 'state.json');
    if (!existsSync(p)) return 0;
    const state = JSON.parse(readFileSync(p, 'utf-8'));
    return state.phases_completed || 0;
  } catch { return 0; }
}

/**
 * Predict whether remaining phases fit in the current session budget.
 *
 * @param {string} cwd - project working directory
 * @returns {{
 *   can_continue: boolean,
 *   remaining_pct: number,
 *   estimated_needed_pct: number,
 *   remaining_phases: number,
 *   avg_tokens_per_phase: number,
 *   recommendation: 'continue' | 'pause_after_current' | 'pause_now'
 * }}
 */
export function predictBudget(cwd) {
  const failOpen = {
    can_continue: true,
    remaining_pct: 100,
    estimated_needed_pct: 0,
    remaining_phases: 0,
    avg_tokens_per_phase: 0,
    recommendation: 'continue',
  };

  // 1. Read context usage (from HUD file bridge)
  const usage = readContextUsage(cwd);
  if (!usage) return failOpen; // No data → fail-open

  // Stale check
  if (Date.now() - usage.timestamp > STALE_THRESHOLD_MS) return failOpen;

  // 2. Remaining budget
  const remainingPct = Math.max(0, 100 - usage.pct);
  const totalTokens = usage.total_tokens || 200000; // fallback to 200K
  const remainingTokens = totalTokens - usage.used_tokens;

  // 3. Critical check: <10% remaining = pause regardless
  if (remainingPct < CRITICAL_REMAINING_PCT) {
    return {
      can_continue: false,
      remaining_pct: Math.round(remainingPct * 10) / 10,
      estimated_needed_pct: remainingPct + 1, // symbolic: more than available
      remaining_phases: readTotalPhases(cwd) - readCompletedPhases(cwd),
      avg_tokens_per_phase: readAvgTokensPerPhase(cwd),
      recommendation: 'pause_now',
    };
  }

  // 4. Estimate remaining cost
  const avgPerPhase = readAvgTokensPerPhase(cwd);
  const totalPhases = readTotalPhases(cwd);
  const completedPhases = readCompletedPhases(cwd);
  const remainingPhases = Math.max(0, totalPhases - completedPhases);

  if (remainingPhases === 0) return failOpen; // nothing left to do

  const estimatedNeededTokens = remainingPhases * avgPerPhase * SAFETY_MARGIN;
  const estimatedNeededPct = (estimatedNeededTokens / totalTokens) * 100;

  // 5. Decision
  let recommendation = 'continue';
  if (estimatedNeededPct > remainingPct) {
    recommendation = 'pause_after_current';
  }

  return {
    can_continue: recommendation === 'continue',
    remaining_pct: Math.round(remainingPct * 10) / 10,
    estimated_needed_pct: Math.round(estimatedNeededPct * 10) / 10,
    remaining_phases: remainingPhases,
    avg_tokens_per_phase: avgPerPhase,
    recommendation,
  };
}
