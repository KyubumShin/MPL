import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDerivedDecompositionFields,
  deriveInvariantsForPhase,
  deriveRiskPatternChecks,
  parseDecompositionPostprocessText,
  parseDesignIntentText,
} from '../lib/mpl-decomposition-postprocess.mjs';

describe('decomposition postprocess risk patterns', () => {
  it('injects default grep checks from impact file languages', () => {
    const checks = deriveRiskPatternChecks({
      id: 'phase-1',
      impact: {
        create: [{ path: 'src/auth.ts' }],
        modify: [{ path: 'src/page.tsx' }],
      },
    });
    assert.deepEqual(checks.map((check) => check.pattern_id), [
      'sec-eval',
      'sec-api-key',
      'sec-sql-concat',
      'sec-innerhtml',
      'sec-weak-crypto',
    ]);
    assert.equal(checks.every((check) => check.source === 'default'), true);
  });

  it('preserves project-specific risk patterns without duplicating defaults', () => {
    const checks = deriveRiskPatternChecks({
      id: 'phase-1',
      impact: { modify: [{ path: 'app/models.py' }] },
      risk_patterns: [
        {
          pattern_id: 'django-raw-sql',
          grep_pattern: '\\.raw\\(',
          severity: 'EXPERIMENTAL',
          target_langs: ['py'],
        },
        {
          pattern_id: 'sec-api-key',
          grep_pattern: 'custom-secret-regex',
          severity: 'EXPERIMENTAL',
          target_langs: ['*'],
        },
      ],
    });
    assert.ok(checks.some((check) => check.pattern_id === 'sec-api-key' && check.source === 'default'));
    assert.ok(checks.some((check) => check.pattern_id === 'django-raw-sql' && check.source === 'project'));
    assert.equal(checks.filter((check) => check.pattern_id === 'sec-api-key').length, 1);
  });
});

describe('decomposition postprocess invariants', () => {
  it('parses design-intent invariants and copies only verbatim public fields', () => {
    const designIntent = parseDesignIntentText(`
invariants:
  - id: INV-1
    statement: "Keep checkout idempotent"
    verify: "npm test -- checkout"
    applies_to_phases: [phase-1]
  - id: INV-2
    statement: "No auth bypass"
    verify: "npm test -- auth"
    applies_to_phases: []
`);
    assert.deepEqual(deriveInvariantsForPhase('phase-1', designIntent), [
      { id: 'INV-1', statement: 'Keep checkout idempotent', verify: 'npm test -- checkout' },
      { id: 'INV-2', statement: 'No auth bypass', verify: 'npm test -- auth' },
    ]);
    assert.deepEqual(deriveInvariantsForPhase('phase-2', designIntent), [
      { id: 'INV-2', statement: 'No auth bypass', verify: 'npm test -- auth' },
    ]);
  });
});

describe('decomposition postprocess aggregate fields', () => {
  it('derives mvp membership, risk checks, and invariants from lean decomposition text', () => {
    const parsed = parseDecompositionPostprocessText(`
goal_contract_hash: abc
execution_tiers:
  - tier: 1
    phases: [phase-2, phase-1]
phases:
  - id: phase-1
    phase_domain: api
    phase_lang: typescript
    impact:
      modify:
        - path: src/api/auth.ts
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: []
      ontology_entities: [auth]
    risk_patterns:
      - pattern_id: auth-cookie-flags
        grep_pattern: "Set-Cookie"
        severity: EXPERIMENTAL
        target_langs: ["*"]
  - id: phase-2
    phase_domain: ui
    impact:
      modify:
        - path: src/Login.tsx
    goal_trace:
      acceptance_criteria: [AC-2]
      variation_axes: [AX-1]
      ontology_entities: [ui]
`);
    const derived = buildDerivedDecompositionFields({
      decomposition: parsed,
      graph: parsed.graph,
      contract: {
        mvp_scope: {
          acceptance_criteria: ['AC-1'],
          variation_axes: ['AX-1'],
          artifact: 'release_manifest',
        },
      },
      designIntent: {
        invariants: [{
          id: 'INV-1',
          statement: 'Auth remains guarded',
          verify: 'npm test -- auth',
          applies_to_phases: ['phase-1'],
        }],
      },
    });

    assert.deepEqual(derived.mvp, {
      derived_from: 'goal_contract.mvp_scope',
      phases: ['phase-2', 'phase-1'],
      execution_mode: 'sequential',
      artifact: 'release_manifest',
    });
    assert.ok(derived.phases['phase-1'].risk_pattern_checks
      .some((check) => check.pattern_id === 'auth-cookie-flags' && check.source === 'project'));
    assert.deepEqual(derived.phases['phase-1'].invariants, [
      { id: 'INV-1', statement: 'Auth remains guarded', verify: 'npm test -- auth' },
    ]);
    assert.deepEqual(derived.phases['phase-2'].invariants, []);
  });
});
