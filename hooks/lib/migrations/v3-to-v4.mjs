/**
 * v3 → v4: Goal Contract + finalize evidence fields.
 *
 * Adds additive defaults for the goal-first harness layer:
 * - `completed_at`, `finalized_at`
 * - `goal_contract_set`, `goal_contract_path`, `goal_contract_hash`
 * - `security_results`
 */

export default {
  from: 3,
  to: 4,
  description: 'Additive backfill — Goal Contract readiness + finalize/security evidence fields',
  migrate(state, _cwd) {
    const merged = { ...state };

    if (!Object.prototype.hasOwnProperty.call(merged, 'completed_at')) merged.completed_at = null;
    if (!Object.prototype.hasOwnProperty.call(merged, 'finalized_at')) merged.finalized_at = null;
    if (typeof merged.goal_contract_set !== 'boolean') merged.goal_contract_set = false;
    if (typeof merged.goal_contract_path !== 'string') merged.goal_contract_path = '.mpl/goal-contract.yaml';
    if (!Object.prototype.hasOwnProperty.call(merged, 'goal_contract_hash')) merged.goal_contract_hash = null;
    if (!merged.security_results || typeof merged.security_results !== 'object' || Array.isArray(merged.security_results)) {
      merged.security_results = {};
    }

    merged.schema_version = 4;
    return merged;
  },
};
