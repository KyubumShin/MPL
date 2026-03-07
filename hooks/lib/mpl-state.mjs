#!/usr/bin/env node
/**
 * MPL State Management Utility
 * Shared helpers for reading/writing .mpl/state.json
 * Based on design document section 12.2
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { loadConfig } from './mpl-config.mjs';

const STATE_DIR = '.mpl';
const STATE_FILE = 'state.json';

/**
 * Default state schema (design doc section 12.2)
 */
const DEFAULT_STATE = {
  pipeline_id: null,
  run_mode: 'full',
  tool_mode: 'full',         // F-04: "full" | "partial" | "standalone"
  pipeline_tier: null,       // F-20: "frugal" | "standard" | "frontier" (set by Triage)
  tier_hint: null,           // F-20: user keyword hint ("frugal" | "standard" | null)
  escalation_history: [],    // F-21: [{from, to, reason, preserved_work, timestamp}]
  current_phase: 'phase1-plan',
  started_at: null,
  plan_approved: false,
  plan_approved_at: null,
  sprint_status: {
    total_todos: 0,
    completed_todos: 0,
    in_progress_todos: 0,
    failed_todos: 0
  },
  gate_results: {
    gate1_passed: null,
    gate2_passed: null,
    gate3_passed: null
  },
  fix_loop_count: 0,
  max_fix_loops: 10,
  cost: {
    total_tokens: 0,
    max_total_tokens: 500000,
    estimated_usd: 0
  },
  convergence: {
    pass_rate_history: [],
    stagnation_window: 3,
    min_improvement: 0.05,
    regression_threshold: -0.10
  },
  research: {
    status: null,           // null | 'stage1' | 'stage2' | 'stage3' | 'completed' | 'skipped'
    started_at: null,
    completed_at: null,
    stages_completed: [],   // ['stage1', 'stage2', 'stage3']
    report_path: null,      // '.mpl/research/report.md' or '.mpl/research/brief.md'
    findings_count: 0,
    sources_count: 0,
    mode: 'full',           // 'full' (3-stage) | 'light' (stage 1 only) | 'standalone'
    error: null,            // failure error message
    degraded_stages: []     // stages with partial failures, e.g. ['stage2']
  }
};

// Prototype pollution guard keys
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Read MPL state from .mpl/state.json
 * @param {string} cwd - Working directory
 * @returns {object|null} State object or null if not found/invalid
 */
export function readState(cwd) {
  try {
    const statePath = join(cwd, STATE_DIR, STATE_FILE);
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    // M5: Minimal schema validation
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!parsed.current_phase) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write/merge MPL state to .mpl/state.json (atomic via temp + rename)
 * @param {string} cwd - Working directory
 * @param {object} patch - Fields to merge into state
 * @returns {object} Merged state
 */
export function writeState(cwd, patch) {
  const stateDir = join(cwd, STATE_DIR);
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const current = readState(cwd) || { ...DEFAULT_STATE };
  const merged = deepMerge(current, patch);

  // C2: Atomic write via temp file + rename
  const tmpPath = join(stateDir, `.state-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  renameSync(tmpPath, join(stateDir, STATE_FILE));

  return merged;
}

/**
 * Check if MPL is currently active
 * @param {string} cwd - Working directory
 * @returns {boolean}
 */
export function isMplActive(cwd) {
  // M6: Check file existence separately from readState
  const statePath = join(cwd, STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return false; // No file = truly inactive

  const state = readState(cwd);
  if (!state) return true; // File exists but corrupt/invalid = fail-closed (assume active)
  if (!state.current_phase) return false;
  // Active if phase is not null and not finalized
  return state.current_phase !== 'completed' && state.current_phase !== 'cancelled';
}

/**
 * Initialize MPL state for a new pipeline run
 * @param {string} cwd - Working directory
 * @param {string} featureName - Name of the feature being built
 * @param {string} runMode - Pipeline mode: 'full' (5-phase) or 'small' (3-phase lightweight)
 * @returns {object} Initial state
 */
/**
 * Escalate pipeline tier to next level (F-21)
 * @param {string} cwd - Working directory
 * @param {string} reason - Reason for escalation (e.g. "circuit_break")
 * @param {object} preservedWork - Summary of preserved work
 * @returns {{ from: string, to: string } | null} Escalation result, or null if already at frontier
 */
export function escalateTier(cwd, reason, preservedWork = {}) {
  const state = readState(cwd);
  if (!state) return null;

  const current = state.pipeline_tier;
  const next = getEscalationTarget(current);
  if (!next) return null;

  const entry = {
    from: current,
    to: next,
    reason,
    preserved_work: preservedWork,
    timestamp: new Date().toISOString(),
  };

  const history = [...(state.escalation_history || []), entry];
  writeState(cwd, { pipeline_tier: next, escalation_history: history });

  return { from: current, to: next };
}

/**
 * Get next escalation tier
 * @param {string} currentTier
 * @returns {string|null} Next tier or null if at frontier
 */
export function getEscalationTarget(currentTier) {
  if (currentTier === 'frugal') return 'standard';
  if (currentTier === 'standard') return 'frontier';
  return null; // frontier → no further escalation
}

export function initState(cwd, featureName, runMode = 'full', tierHint = null) {
  // H5: Load config overrides
  let config = {};
  try {
    config = loadConfig(cwd);
  } catch {
    // Config load failed, use defaults
  }

  const now = new Date().toISOString();
  const dateStr = now.slice(0, 10).replace(/-/g, '');
  // M1: Support Korean/CJK characters in slug
  const slug = featureName.toLowerCase()
    .replace(/[^a-z0-9가-힣ぁ-ゔァ-ヴ\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  const isSmall = runMode === 'small' || tierHint === 'standard';
  const isFrugal = tierHint === 'frugal';

  const maxFixLoops = config.max_fix_loops ?? (isFrugal ? 3 : isSmall ? 5 : 10);
  const maxTokens = config.max_total_tokens ?? (isFrugal ? 80000 : isSmall ? 150000 : 500000);
  const convergenceConfig = config.convergence ?? {};

  const tierPrefix = isFrugal ? 'frugal-' : isSmall ? 'small-' : '';
  return writeState(cwd, {
    ...DEFAULT_STATE,
    pipeline_id: `mpl-${tierPrefix}${dateStr}-${slug}`,
    run_mode: runMode === 'auto' ? 'auto' : runMode,
    pipeline_tier: null,           // Set by Triage after Quick Scope Scan
    tier_hint: tierHint,
    escalation_history: [],
    current_phase: isFrugal ? 'phase1a-research' : isSmall ? 'small-plan' : 'phase1a-research',
    max_fix_loops: maxFixLoops,
    cost: {
      ...DEFAULT_STATE.cost,
      max_total_tokens: maxTokens
    },
    convergence: {
      ...DEFAULT_STATE.convergence,
      ...convergenceConfig
    },
    research: {
      ...DEFAULT_STATE.research,
      mode: isSmall ? 'light' : 'full'
    },
    started_at: now
  });
}

/**
 * Check convergence of fix loop pass rates
 * Enhanced in v3: stagnation detection with variance, regression detection, strategy suggestions
 * @param {object} state - Current MPL state
 * @returns {{ status: string, delta?: number, suggestion?: string }}
 */
export function checkConvergence(state) {
  const conv = state?.convergence;
  if (!conv) return { status: 'insufficient_data' };

  const { pass_rate_history, stagnation_window = 3, min_improvement = 0.05, regression_threshold = -0.1 } = conv;
  if (!Array.isArray(pass_rate_history) || pass_rate_history.length < 2) return { status: 'insufficient_data' };

  const windowSize = Math.min(stagnation_window, pass_rate_history.length);
  const recent = pass_rate_history.slice(-windowSize);
  const latest = recent[recent.length - 1];
  const earliest = recent[0];
  const improvement = latest - earliest;

  // v3: Regression detection (delta < -10%)
  if (improvement < regression_threshold) {
    return {
      status: 'regressing',
      delta: improvement,
      suggestion: 'Pass rate is declining. Consider reverting to last known good state or reviewing Phase 0 artifacts.'
    };
  }

  // v3: Stagnation detection with variance check
  if (recent.length >= stagnation_window) {
    // Calculate variance of recent pass rates
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / recent.length;

    if (variance < 0.0025 && improvement < min_improvement) {
      // variance < 5% (0.05^2 = 0.0025) AND no meaningful improvement
      return {
        status: 'stagnating',
        delta: improvement,
        suggestion: 'Fix loop is not making progress. Try a different strategy: change implementation approach, consult Phase 0 artifacts, or escalate to redecomposition.'
      };
    }

    if (improvement < min_improvement) {
      return { status: 'stagnating', delta: improvement, suggestion: 'Improvement is below threshold. Consider changing fix strategy.' };
    }
  }

  return { status: 'improving', delta: improvement };
}

/**
 * Deep merge two objects (shallow for arrays, with prototype pollution guard)
 */
export function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    // Prototype pollution guard
    if (DANGEROUS_KEYS.has(key)) continue;

    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
