/**
 * MPL Enforcement Policy Resolver (P0-2 / #110)
 *
 * Single source for resolving the effective enforcement policy at any hook.
 * Replaces direct `state.enforcement?.strict` reads scattered across:
 *   - hooks/mpl-phase-controller.mjs (P0-1, #102)
 *   - hooks/mpl-fallback-grep.mjs (F3, #105)
 *   - hooks/mpl-bash-timeout.mjs (G1, #107)
 *
 * Precedence (highest → lowest):
 *   1. state.json `enforcement.*` — per-pipeline runtime override (e.g. `--strict` flag)
 *   2. .mpl/config.json `enforcement.*` — workspace baseline
 *   3. hooks/lib/mpl-config.mjs DEFAULTS.enforcement — hard-coded fallback
 *
 * Pure functions. No side effects beyond reading config / passed-in state.
 */

import { loadConfig } from './mpl-config.mjs';

/**
 * Resolve the effective enforcement policy object.
 *
 * @param {string} cwd - Working directory (for config lookup)
 * @param {object | null | undefined} state - Pipeline state.json contents (or null)
 * @returns {{
 *   strict: boolean,
 *   direct_source_edit: 'warn' | 'block' | 'off',
 *   phase_scope_violation: 'warn' | 'block' | 'off',
 *   missing_gate_evidence: 'warn' | 'block' | 'off',
 *   missing_artifact_schema: 'warn' | 'block' | 'off',
 *   anti_pattern_match: 'warn' | 'block' | 'off',
 *   state_invariant_violation: 'warn' | 'block' | 'off',
 *   bash_timeout_violation: 'warn' | 'block' | 'off',
 * }}
 */
export function getEnforcementPolicy(cwd, state) {
  const config = loadConfig(cwd);
  const baseline = (config && typeof config.enforcement === 'object') ? config.enforcement : {};
  const override = (state && typeof state === 'object' && typeof state.enforcement === 'object' && state.enforcement)
    ? state.enforcement
    : {};
  return { ...baseline, ...override };
}

/**
 * Strict-mode boolean shortcut. Used by hooks that gate on the global toggle
 * rather than a per-rule policy.
 *
 * @param {string} cwd
 * @param {object | null | undefined} state
 * @returns {boolean}
 */
export function isStrict(cwd, state) {
  return getEnforcementPolicy(cwd, state).strict === true;
}

/**
 * Resolve a single rule's effective action, honouring strict elevation.
 *
 * - If the rule's policy is `warn` and strict is on → `block` (elevated).
 * - If the rule's policy is `block` → `block` regardless of strict.
 * - If the rule's policy is `off` → `off` regardless of strict (explicit opt-out).
 *
 * @param {string} cwd
 * @param {object | null | undefined} state
 * @param {string} ruleId - e.g. 'anti_pattern_match', 'bash_timeout_violation'
 * @returns {'warn' | 'block' | 'off'}
 */
export function resolveRuleAction(cwd, state, ruleId) {
  const policy = getEnforcementPolicy(cwd, state);
  const ruleValue = policy[ruleId];
  if (ruleValue === 'off') return 'off';
  if (ruleValue === 'block') return 'block';
  // 'warn' or anything truthy that isn't 'off'/'block' → strict elevates
  return policy.strict === true ? 'block' : 'warn';
}
