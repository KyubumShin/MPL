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

const DEFAULTS = {
  max_fix_loops: 10,
  gate1_strategy: 'auto',  // 'docker', 'native', 'skip'
  hitl_timeout_seconds: 30,
  convergence: {
    stagnation_window: 3,
    min_improvement: 0.05,
    regression_threshold: -0.1
  }
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
