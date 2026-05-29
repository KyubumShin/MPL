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
  audit_residual: 'warn',
};

const PARALLELISM_DEFAULTS = {
  max_phase_workers: 2,
};

const MAX_PHASE_WORKERS_LIMIT = 3;

const TEST_WAIT_DEFAULTS = {
  cache_mode: 'default',
  threshold_default_sec: 270,
  threshold_extended_sec: 3300,
  pipelining_enabled: true,
};

// #240: extracted hard-coded thresholds. All defaults keep the prior
// behavior; setting these in `.mpl/config.json` is opt-in relaxation.
//   phase0_artifacts_required — when false, allow protected-phase
//       transitions without raw-scan.md / design-intent.yaml / contracts.
//   test_agent.default_required — when false, absence in
//       decomposition.yaml means NOT required (overrides AD-0007).
//   ambiguity.threshold — float upper bound (default 0.2). Scores ≤
//       threshold proceed; scores > threshold loop back to ambiguity-resolve.
//   ambiguity.force_proceed_after_rounds — when set, allow
//       state.ambiguity_force_proceed: true to override threshold after
//       N rounds; null means no force-proceed path.
//   gate_classify.allowed_heads — extends/replaces STRICT_GATE_HEAD_ALLOWLIST
//       (manual gate evidence head allowlist).
//   bash_timeout.{category}.max_ms — per-category ceiling override.
const PHASE0_ARTIFACTS_REQUIRED_DEFAULT = true;
const TEST_AGENT_DEFAULTS = { default_required: true };
const AMBIGUITY_DEFAULTS = { threshold: 0.2, force_proceed_after_rounds: null };
const GATE_CLASSIFY_DEFAULTS = { allowed_heads: [] };
const BASH_TIMEOUT_DEFAULTS = {};

const DEFAULTS = {
  max_fix_loops: 10,
  gate1_strategy: 'auto',  // 'docker', 'native', 'skip'
  hitl_timeout_seconds: 30,
  goal_contract_required: true,
  goal_trace_required: true,
  phase_contract_graph_required: true,
  decomposition_delta_required: true,
  phase_evidence_latch_required: true,
  completed_phase_immutability_required: true,
  whole_goal_closure_required: true,
  e2e_authenticity_required: true,
  finalize_artifacts_required: true,
  phase0_artifacts_required: PHASE0_ARTIFACTS_REQUIRED_DEFAULT,
  test_agent: TEST_AGENT_DEFAULTS,
  ambiguity: AMBIGUITY_DEFAULTS,
  gate_classify: GATE_CLASSIFY_DEFAULTS,
  bash_timeout: BASH_TIMEOUT_DEFAULTS,
  convergence: {
    stagnation_window: 3,
    min_improvement: 0.05,
    regression_threshold: -0.1
  },
  parallelism: PARALLELISM_DEFAULTS,
  test_wait: TEST_WAIT_DEFAULTS,
  enforcement: ENFORCEMENT_DEFAULTS,
  overrides: [],
};

function normalizeMaxPhaseWorkers(value) {
  if (!Number.isInteger(value)) return PARALLELISM_DEFAULTS.max_phase_workers;
  return Math.min(MAX_PHASE_WORKERS_LIMIT, Math.max(1, value));
}

function normalizeConfig(config) {
  const parallelism = (
    config?.parallelism &&
    typeof config.parallelism === 'object' &&
    !Array.isArray(config.parallelism)
  )
    ? config.parallelism
    : {};

  return {
    ...config,
    parallelism: {
      ...PARALLELISM_DEFAULTS,
      ...parallelism,
      max_phase_workers: normalizeMaxPhaseWorkers(parallelism.max_phase_workers),
    },
  };
}

/**
 * Load MPL config from .mpl/config.json, falling back to defaults.
 * @param {string} cwd - Working directory
 * @returns {object} Merged config
 */
export function loadConfig(cwd) {
  const configPath = join(cwd, '.mpl', 'config.json');
  if (!existsSync(configPath)) return normalizeConfig(DEFAULTS);
  try {
    const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    return normalizeConfig(deepMergeConfig(DEFAULTS, userConfig));
  } catch {
    return normalizeConfig(DEFAULTS);
  }
}
