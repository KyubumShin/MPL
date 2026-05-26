import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  buildDerivedDecompositionFields,
  deriveInvariantsForPhase,
  deriveRiskPatternChecks,
  parseDecompositionPostprocessText,
  parseDesignIntentText,
} from '../lib/mpl-decomposition-postprocess.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');

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

  it('preserves project-specific risk patterns, including stricter default-id variants', () => {
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
    assert.equal(checks.filter((check) => check.pattern_id === 'sec-api-key').length, 2);
  });

  it('parses block-list target_langs and scopes grep commands to matching files', () => {
    const parsed = parseDecompositionPostprocessText(`
phases:
  - id: phase-1
    impact:
      modify:
        - path: src/page.tsx
        - path: app/models.py
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: []
      ontology_entities: [ui]
    risk_patterns:
      - pattern_id: ts-only-risk
        grep_pattern: "dangerousTs"
        severity: EXPERIMENTAL
        target_langs:
          - ts
`);
    const checks = deriveRiskPatternChecks(parsed.phases[0]);
    const custom = checks.find((check) => check.pattern_id === 'ts-only-risk');
    assert.ok(custom);
    assert.match(custom.command, /src\/page\.tsx/);
    assert.doesNotMatch(custom.command, /app\/models\.py/);
  });

  it('does not treat non-impact contract file paths as grep targets', () => {
    const parsed = parseDecompositionPostprocessText(`
phases:
  - id: phase-1
    phase_lang: typescript
    impact:
      modify:
        - path: src/auth.ts
    interface_contract:
      contract_files:
        - path: .mpl/contracts/phase-1.json
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: []
      ontology_entities: [auth]
`);
    const checks = deriveRiskPatternChecks(parsed.phases[0]);
    const apiKey = checks.find((check) => check.pattern_id === 'sec-api-key');
    assert.ok(apiKey);
    assert.match(apiKey.command, /src\/auth\.ts/);
    assert.doesNotMatch(apiKey.command, /\.mpl\/contracts\/phase-1\.json/);
  });

  it('skips project-specific patterns when target_langs is omitted', () => {
    const checks = deriveRiskPatternChecks({
      id: 'phase-1',
      impact: { modify: [{ path: 'src/auth.ts' }] },
      risk_patterns: [{
        pattern_id: 'missing-targets',
        grep_pattern: 'customDanger',
        severity: 'EXPERIMENTAL',
      }],
    });
    assert.equal(checks.some((check) => check.pattern_id === 'missing-targets'), false);
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

  it('parses block-list applies_to_phases without broadening scope', () => {
    const designIntent = parseDesignIntentText(`
invariants:
  - id: INV-1
    statement: "Only checkout"
    verify: "npm test -- checkout"
    applies_to_phases:
      - phase-1
`);
    assert.deepEqual(deriveInvariantsForPhase('phase-1', designIntent), [
      { id: 'INV-1', statement: 'Only checkout', verify: 'npm test -- checkout' },
    ]);
    assert.deepEqual(deriveInvariantsForPhase('phase-2', designIntent), []);
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

describe('decomposition postprocess hook', () => {
  function withTmp(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'mpl-postprocess-hook-'));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('regenerates decomposition-derived.json after decomposition.yaml writes', () => withTmp((dir) => {
    mkdirSync(join(dir, '.mpl', 'mpl', 'phase0'), { recursive: true });
    writeFileSync(join(dir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'mpl-decompose',
    }, null, 2));
    writeFileSync(join(dir, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'), `
invariants:
  - id: INV-1
    statement: "Auth remains guarded"
    verify: "npm test -- auth"
    applies_to_phases: [phase-1]
`);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
goal_contract_hash: abc
phases:
  - id: phase-1
    phase_lang: typescript
    impact:
      modify:
        - path: src/auth.ts
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: []
      ontology_entities: [auth]
`);

    const input = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml' },
    };
    const result = spawnSync(process.execPath, [join(ROOT, 'hooks', 'mpl-decomposition-postprocess.mjs')], {
      cwd: dir,
      input: JSON.stringify(input),
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr);
    const hookResult = JSON.parse(result.stdout);
    assert.equal(hookResult.continue, true);
    const derived = JSON.parse(readFileSync(join(dir, '.mpl', 'mpl', 'decomposition-derived.json'), 'utf-8'));
    assert.deepEqual(derived.phases['phase-1'].invariants, [
      { id: 'INV-1', statement: 'Auth remains guarded', verify: 'npm test -- auth' },
    ]);
    assert.ok(derived.phases['phase-1'].risk_pattern_checks
      .some((check) => check.pattern_id === 'sec-api-key'));
  }));
});
