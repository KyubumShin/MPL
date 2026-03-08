#!/usr/bin/env node
/**
 * MPL Debug Logger
 * Shared utility for internal decision/thinking process logging.
 *
 * Toggle: .mpl/config.json -> "debug": { "enabled": true }
 * Output: .mpl/mpl/debug.log (append-only, timestamped)
 *
 * Categories:
 *   triage, phase-transition, escalation, convergence,
 *   routing, model-selection, gate, context-assembly,
 *   agent-dispatch, state-change, error
 */

import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const DEBUG_DIR = '.mpl/mpl';
const DEBUG_FILE = 'debug.log';
const CONFIG_DIR = '.mpl';
const CONFIG_FILE = 'config.json';

/**
 * Check if debug logging is enabled via .mpl/config.json
 * @param {string} cwd - Working directory
 * @returns {{ enabled: boolean, categories: string[] }}
 */
export function getDebugConfig(cwd) {
  try {
    const configPath = join(cwd, CONFIG_DIR, CONFIG_FILE);
    if (!existsSync(configPath)) return { enabled: false, categories: ['all'] };

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const debug = config.debug;

    if (!debug) return { enabled: false, categories: ['all'] };
    if (typeof debug === 'boolean') return { enabled: debug, categories: ['all'] };

    return {
      enabled: debug.enabled === true,
      categories: Array.isArray(debug.categories) ? debug.categories : ['all'],
    };
  } catch {
    return { enabled: false, categories: ['all'] };
  }
}

/**
 * Check if debug is enabled (simple boolean check)
 * @param {string} cwd - Working directory
 * @returns {boolean}
 */
export function isDebugEnabled(cwd) {
  return getDebugConfig(cwd).enabled;
}

/**
 * Write a debug log entry
 * No-op if debug is disabled or category is filtered out.
 *
 * @param {string} cwd - Working directory
 * @param {string} category - Log category (triage, phase-transition, etc.)
 * @param {string} message - Human-readable description of what happened
 * @param {object} [context={}] - Structured context (decision inputs, state snapshot, etc.)
 * @returns {boolean} Whether the log was written
 */
export function debugLog(cwd, category, message, context = {}) {
  try {
    const config = getDebugConfig(cwd);
    if (!config.enabled) return false;

    // Category filter: 'all' means log everything
    if (!config.categories.includes('all') && !config.categories.includes(category)) {
      return false;
    }

    const logDir = join(cwd, DEBUG_DIR);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const contextStr = Object.keys(context).length > 0
      ? `\n  context: ${JSON.stringify(context)}`
      : '';

    const entry = `[${timestamp}] [${category.toUpperCase()}] ${message}${contextStr}\n`;

    appendFileSync(join(logDir, DEBUG_FILE), entry, 'utf-8');
    return true;
  } catch {
    // Debug logging must never break the pipeline
    return false;
  }
}

/**
 * Log a decision point with inputs and outcome
 * @param {string} cwd
 * @param {string} category
 * @param {string} decision - What was decided
 * @param {object} inputs - What inputs led to this decision
 * @param {string} reasoning - Why this decision was made
 */
export function debugDecision(cwd, category, decision, inputs = {}, reasoning = '') {
  return debugLog(cwd, category, `DECISION: ${decision}`, {
    inputs,
    reasoning,
    type: 'decision',
  });
}

/**
 * Log a state transition
 * @param {string} cwd
 * @param {string} from - Previous state
 * @param {string} to - New state
 * @param {string} trigger - What caused the transition
 */
export function debugTransition(cwd, from, to, trigger = '') {
  return debugLog(cwd, 'state-change', `${from} → ${to}`, {
    from,
    to,
    trigger,
    type: 'transition',
  });
}

/**
 * Log an error or unexpected condition (always logs if debug enabled, ignores category filter)
 * @param {string} cwd
 * @param {string} message
 * @param {object} context
 */
export function debugError(cwd, message, context = {}) {
  try {
    const config = getDebugConfig(cwd);
    if (!config.enabled) return false;

    const logDir = join(cwd, DEBUG_DIR);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const contextStr = Object.keys(context).length > 0
      ? `\n  context: ${JSON.stringify(context)}`
      : '';

    const entry = `[${timestamp}] [ERROR] ${message}${contextStr}\n`;
    appendFileSync(join(logDir, DEBUG_FILE), entry, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the debug log file
 * @param {string} cwd
 */
export function clearDebugLog(cwd) {
  try {
    const logPath = join(cwd, DEBUG_DIR, DEBUG_FILE);
    if (existsSync(logPath)) {
      writeFileSync(logPath, '', 'utf-8');
    }
  } catch {
    // best-effort
  }
}
