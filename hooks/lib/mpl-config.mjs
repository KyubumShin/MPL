/**
 * MPL Configuration Loader
 * Loads user-defined overrides from .mpl/config.json with sensible defaults.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Deep merge for config: nested objects are merged, arrays and primitives are replaced.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMergeConfig(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = deepMergeConfig(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Enforcement defaults (P0-2, #110). Mirrored in `config/enforcement.json` for
 * human reference. This object is the runtime source-of-truth — JSON file is
 * declarative documentation that tools (doctor, skill docs) can also read.
 *
 * Schema:
 * - `strict`: boolean — when true, all per-rule `warn` policies elevate to `block`
 *   at the consuming hook's discretion.
 * - per-rule `warn` | `block` | `off` — policy for that specific violation. Workspace
 *   or state can pin `block` regardless of strict (per issue #110 elevation rules);
 *   `off` is an explicit opt-out.
 * - `overrides`: [] — audit trail entries `{rule, value, reason, timestamp, source}`.
 *
 * Precedence (highest → lowest):
 *   state.json `enforcement.*`  >  .mpl/config.json `enforcement.*`  >  this DEFAULTS
 *
 * v0.18.0 ships ALL rules at `warn` by default per issue #110 §정책 ("default:
 * transitional warn (사용자 surface 만, 차단 없음); exp16부터 strict: true"). Hooks
 * never silently downgrade — workspace must explicitly opt-in to block.
 */
const ENFORCEMENT_DEFAULTS = {
  strict: false,
  direct_source_edit: 'warn',
  phase_scope_violation: 'warn',
  missing_gate_evidence: 'warn',
  missing_artifact_schema: 'warn',
  anti_pattern_match: 'warn',
  state_invariant_violation: 'warn',
  bash_timeout_violation: 'warn',
};

const DEFAULTS = {
  max_fix_loops: 10,
  gate1_strategy: 'auto',  // 'docker', 'native', 'skip'
  hitl_timeout_seconds: 30,
  convergence: {
    stagnation_window: 3,
    min_improvement: 0.05,
    regression_threshold: -0.1
  },
  enforcement: ENFORCEMENT_DEFAULTS,
  overrides: [],
};

/**
 * Load MPL config from .mpl/config.json, falling back to defaults.
 * @param {string} cwd - Working directory
 * @returns {object} Merged config
 */
export function loadConfig(cwd) {
  const configPath = join(cwd, '.mpl', 'config.json');
  if (!existsSync(configPath)) return { ...DEFAULTS };
  try {
    const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    return deepMergeConfig(DEFAULTS, userConfig);
  } catch {
    return { ...DEFAULTS };
  }
}
