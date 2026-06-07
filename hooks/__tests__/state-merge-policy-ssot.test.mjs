/**
 * SSOT enforcement — BUILTIN_MERGE_POLICY (wave-reducer.mjs) ↔
 * mpl.config.yaml#state.merge_policy.
 *
 * Move #17 declares mpl.config.yaml#state.merge_policy as the authoritative
 * field-ownership matrix. `lib/state/wave-reducer.mjs` ships a BUILTIN_MERGE_POLICY
 * copy as defense-in-depth so the reducer can run without a YAML load and
 * never silently relaxes the contract.
 *
 * The two registries MUST stay in lockstep. Drift means either:
 *   (a) a new field landed in YAML but the reducer's embedded copy is stale
 *       (defense-in-depth fail-open), OR
 *   (b) a field was removed from YAML but BUILTIN still references it
 *       (the reducer would accept a field the canonical policy rejects).
 *
 * This test loads both via `loadConfigV2` (which already does YAML parse +
 * deep-merge + caching) and asserts:
 *   1. every BUILTIN key is present in YAML state.merge_policy with the
 *      same policy string;
 *   2. every YAML state.merge_policy key is present in BUILTIN with the
 *      same policy string;
 *   3. specific spot-checks for keys whose drift is most painful
 *      (`reconciler_reentries`, `engine_only` fields).
 *
 * The runtime warning path in wave-reducer is the operator-visible backup;
 * this test is the structural enforcer that fails CI on drift.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_MERGE_POLICY } from '../lib/state/wave-reducer.mjs';
import { loadConfigV2 } from '../lib/config.mjs';

describe('BUILTIN_MERGE_POLICY ↔ mpl.config.yaml#state.merge_policy SSOT', () => {
  // Load the canonical YAML once via loadConfigV2 — it handles the
  // repo-root fallback used by every other v2 caller. Using `undefined`
  // for cwd causes loadConfigV2 to resolve the repo-root mpl.config.yaml.
  const cfg = loadConfigV2(undefined);
  const yamlPolicy = cfg?.state?.merge_policy;

  it('mpl.config.yaml#state.merge_policy is present + non-empty', () => {
    assert.ok(yamlPolicy, 'mpl.config.yaml#state.merge_policy missing');
    assert.ok(Object.keys(yamlPolicy).length > 0, 'state.merge_policy is empty');
  });

  it('every BUILTIN_MERGE_POLICY key matches a YAML entry with the same policy', () => {
    const drift = [];
    for (const [field, builtinPolicy] of Object.entries(BUILTIN_MERGE_POLICY)) {
      const yamlValue = yamlPolicy?.[field];
      if (yamlValue === undefined) {
        drift.push(`${field}: BUILTIN=${builtinPolicy}, YAML=<missing>`);
      } else if (yamlValue !== builtinPolicy) {
        drift.push(`${field}: BUILTIN=${builtinPolicy}, YAML=${yamlValue}`);
      }
    }
    assert.deepEqual(
      drift,
      [],
      `BUILTIN_MERGE_POLICY drift vs mpl.config.yaml:\n  - ${drift.join('\n  - ')}\n` +
      `Update hooks/lib/state/wave-reducer.mjs#BUILTIN_MERGE_POLICY to match the YAML, ` +
      `or update mpl.config.yaml#state.merge_policy if the YAML is the one out of date.`,
    );
  });

  it('every YAML state.merge_policy key with a SCALAR top-level field is mirrored in BUILTIN', () => {
    // YAML allows dotted sub-paths like `convergence.pass_rate_history` and
    // `execution.phases.completed` — those are sub-policies for nested fields
    // that BUILTIN does not need to enumerate (the reducer routes them by
    // top-level key). The SSOT contract here is over TOP-LEVEL scalar keys
    // only.
    const drift = [];
    for (const [field, yamlValue] of Object.entries(yamlPolicy)) {
      if (field.includes('.')) continue; // nested sub-policy, not BUILTIN's job
      const builtinPolicy = BUILTIN_MERGE_POLICY[field];
      if (builtinPolicy === undefined) {
        drift.push(`${field}: YAML=${yamlValue}, BUILTIN=<missing>`);
      } else if (builtinPolicy !== yamlValue) {
        drift.push(`${field}: YAML=${yamlValue}, BUILTIN=${builtinPolicy}`);
      }
    }
    assert.deepEqual(
      drift,
      [],
      `mpl.config.yaml top-level merge_policy drift vs BUILTIN:\n  - ${drift.join('\n  - ')}\n` +
      `Add the missing field to hooks/lib/state/wave-reducer.mjs#BUILTIN_MERGE_POLICY, ` +
      `or remove the field from mpl.config.yaml if the BUILTIN exclusion is intentional.`,
    );
  });

  it('reconciler_reentries declares phase_keyed in both registries', () => {
    // Specific guard — reconciler_reentries was the trigger for this SSOT
    // test (added in Move #17, dormant until reconcile lifts the wave_end
    // route). Drift here would let the wave reducer silently accept an
    // unknown shape and propagate the merge into state.
    assert.equal(BUILTIN_MERGE_POLICY.reconciler_reentries, 'phase_keyed');
    assert.equal(yamlPolicy?.reconciler_reentries, 'phase_keyed');
  });

  it('engine_only field set is symmetric (no shard can patch them)', () => {
    const builtinEngineOnly = Object.entries(BUILTIN_MERGE_POLICY)
      .filter(([, p]) => p === 'engine_only')
      .map(([k]) => k)
      .sort();
    const yamlEngineOnly = Object.entries(yamlPolicy)
      .filter(([k, p]) => p === 'engine_only' && !k.includes('.'))
      .map(([k]) => k)
      .sort();
    assert.deepEqual(
      builtinEngineOnly,
      yamlEngineOnly,
      `engine_only field set drift:\n` +
      `  BUILTIN=${builtinEngineOnly.join(',')}\n` +
      `  YAML=   ${yamlEngineOnly.join(',')}\n` +
      `engine_only fields are pipeline-scoped; both registries must agree on the rejection set.`,
    );
  });
});
