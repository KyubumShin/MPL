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
  writeTestAgentBriefs,
} from '../lib/mpl-decomposition-postprocess.mjs';
import { validateBrief } from '../lib/mpl-test-agent-brief.mjs';
import { existsSync } from 'node:fs';
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

  function writeActiveState(dir) {
    mkdirSync(join(dir, '.mpl', 'mpl', 'phase0'), { recursive: true });
    writeFileSync(join(dir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'mpl-decompose',
    }, null, 2));
  }

  function writeDesignIntent(dir, statement = 'Auth remains guarded') {
    writeFileSync(join(dir, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'), `
invariants:
  - id: INV-1
    statement: "${statement}"
    verify: "npm test -- auth"
    applies_to_phases: [phase-1]
`);
  }

  function writeDecomposition(dir) {
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
goal_contract_hash: abc
execution_tiers:
  - tier: 1
    phases: [phase-1, phase-2]
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
  - id: phase-2
    phase_lang: typescript
    impact:
      modify:
        - path: src/checkout.ts
    goal_trace:
      acceptance_criteria: [AC-2]
      variation_axes: []
      ontology_entities: [checkout]
`);
  }

  function writeGoalContract(dir, mvpAcceptanceCriteria = 'AC-1') {
    writeFileSync(join(dir, '.mpl', 'goal-contract.yaml'), `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Build app"
  project_pivot: "real runtime"
  must_ship_outcomes:
    - "usable app"
ontology:
  entities:
    - app
variation_axes:
  - id: AX-1
acceptance_criteria:
  - id: AC-1
  - id: AC-2
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/RUNBOOK.md
  require_commit: false
  require_finalize_timestamps: true
mvp_scope:
  acceptance_criteria: [${mvpAcceptanceCriteria}]
  variation_axes: []
  artifact: release_manifest
`);
  }

  function runHook(dir, filePath) {
    const input = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: filePath },
    };
    const result = spawnSync(process.execPath, [join(ROOT, 'hooks', 'mpl-decomposition-postprocess.mjs')], {
      cwd: dir,
      input: JSON.stringify(input),
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  it('regenerates decomposition-derived.json after decomposition.yaml writes', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeDecomposition(dir);

    const hookResult = runHook(dir, '.mpl/mpl/decomposition.yaml');
    assert.equal(hookResult.continue, true);
    const derived = JSON.parse(readFileSync(join(dir, '.mpl', 'mpl', 'decomposition-derived.json'), 'utf-8'));
    assert.deepEqual(derived.phases['phase-1'].invariants, [
      { id: 'INV-1', statement: 'Auth remains guarded', verify: 'npm test -- auth' },
    ]);
    assert.ok(derived.phases['phase-1'].risk_pattern_checks
      .some((check) => check.pattern_id === 'sec-api-key'));
  }));

  it('regenerates decomposition-derived.json after design-intent.yaml writes', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir, 'Old invariant');
    writeDecomposition(dir);
    assert.equal(runHook(dir, '.mpl/mpl/decomposition.yaml').continue, true);

    writeDesignIntent(dir, 'Updated invariant');
    const hookResult = runHook(dir, '.mpl/mpl/phase0/design-intent.yaml');

    assert.equal(hookResult.continue, true);
    const derived = JSON.parse(readFileSync(join(dir, '.mpl', 'mpl', 'decomposition-derived.json'), 'utf-8'));
    assert.deepEqual(derived.phases['phase-1'].invariants, [
      { id: 'INV-1', statement: 'Updated invariant', verify: 'npm test -- auth' },
    ]);
  }));

  it('regenerates decomposition-derived.json after goal-contract.yaml writes', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeDecomposition(dir);
    writeGoalContract(dir, 'AC-1');
    assert.equal(runHook(dir, '.mpl/mpl/decomposition.yaml').continue, true);

    writeGoalContract(dir, 'AC-2');
    const hookResult = runHook(dir, '.mpl/goal-contract.yaml');

    assert.equal(hookResult.continue, true);
    const derived = JSON.parse(readFileSync(join(dir, '.mpl', 'mpl', 'decomposition-derived.json'), 'utf-8'));
    assert.deepEqual(derived.mvp, {
      derived_from: 'goal_contract.mvp_scope',
      phases: ['phase-2'],
      execution_mode: 'sequential',
      artifact: 'release_manifest',
    });
  }));

  it('does not block Phase 0 source writes before decomposition.yaml exists', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);

    const hookResult = runHook(dir, '.mpl/mpl/phase0/design-intent.yaml');

    assert.equal(hookResult.continue, true);
  }));

  /* ────────────────── #225: test-agent-brief producer ────────────────── */

  it('writes a brief for every required phase after decomposition.yaml write', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
goal_contract_hash: abc
phases:
  - id: phase-1
    phase_lang: typescript
    phase_domain: api
    test_agent_required: true
    impact:
      modify:
        - path: src/api/widgets.ts
    interface_contract:
      produces:
        - symbol: createWidget
          path: src/api/widgets.ts
    verification_plan:
      a_items:
        - id: A-1
          statement: "POST /widgets returns 201 with a valid body"
      s_items:
        - id: S-1
          statement: "POST /widgets returns 422 on missing field"
    probing_hints:
      - "retry on transient 5xx returns failure"
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: []
      ontology_entities: [api]
  - id: phase-2
    phase_lang: typescript
    phase_domain: docs
    test_agent_required: false
    impact:
      modify:
        - path: docs/widgets.md
    goal_trace:
      acceptance_criteria: [AC-2]
      variation_axes: []
      ontology_entities: [docs]
`);

    const hookResult = runHook(dir, '.mpl/mpl/decomposition.yaml');
    assert.equal(hookResult.continue, true);

    const briefP1 = join(dir, '.mpl', 'mpl', 'phases', 'phase-1', 'test-agent-brief.yaml');
    const briefP2 = join(dir, '.mpl', 'mpl', 'phases', 'phase-2', 'test-agent-brief.yaml');
    assert.ok(existsSync(briefP1), 'phase-1 brief should be written (test_agent_required: true)');
    assert.ok(!existsSync(briefP2), 'phase-2 brief should NOT be written (test_agent_required: false)');

    // The produced brief must pass the #224 validator (round-trip).
    const text = readFileSync(briefP1, 'utf-8');
    const { valid, errors } = validateBrief(text, { phaseId: 'phase-1' });
    assert.equal(valid, true, `brief should be valid, errors: ${errors.join(', ')}`);
    assert.match(text, /target_implementation_files:\s*\n\s*-\s+"src\/api\/widgets\.ts"/);
    assert.match(text, /a_item_coverage:[\s\S]*A-1[\s\S]*POST \/widgets/);
    assert.match(text, /s_item_coverage:[\s\S]*S-1[\s\S]*422/);
    assert.match(text, /probing_targets:[\s\S]*retry on transient 5xx/);
  }));

  it('writeTestAgentBriefs is idempotent — re-running rewrites the same brief', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-1
    phase_lang: typescript
    phase_domain: api
    test_agent_required: true
    impact:
      modify:
        - path: src/x.ts
    interface_contract:
      produces:
        - symbol: f
          path: src/x.ts
    verification_plan:
      a_items:
        - id: A-1
          statement: "f returns 1"
      s_items:
        - id: S-1
          statement: "f handles 0"
`);
    const ids1 = writeTestAgentBriefs(dir);
    const ids2 = writeTestAgentBriefs(dir);
    assert.deepEqual(ids1, ['phase-1']);
    assert.deepEqual(ids2, ['phase-1']);
    const briefPath = join(dir, '.mpl', 'mpl', 'phases', 'phase-1', 'test-agent-brief.yaml');
    assert.ok(existsSync(briefPath));
  }));

  it('phase with implicit test_agent_required (omitted field) defaults to required', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-implicit
    phase_lang: typescript
    phase_domain: api
    impact:
      modify:
        - path: src/y.ts
    interface_contract:
      produces:
        - symbol: g
          path: src/y.ts
    verification_plan:
      a_items:
        - id: A-1
          statement: "g returns 2"
      s_items:
        - id: S-1
          statement: "g handles null"
`);
    writeTestAgentBriefs(dir);
    assert.ok(existsSync(join(dir, '.mpl', 'mpl', 'phases', 'phase-implicit', 'test-agent-brief.yaml')));
  }));

  it('codex r3 [contract-break]: parses the canonical decomposer schema (name/spec + criterion/test_command)', () => withTmp((dir) => {
    // Schema mirrors agents/mpl-decomposer.md:439-476 — the actual
    // shape the decomposer emits in production. Pre-codex-r3 the
    // producer only knew the test-only {symbol/path, id/statement}
    // shape, so a real phase would produce an empty brief.
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-canonical
    phase_lang: python
    phase_domain: api
    test_agent_required: true
    impact:
      modify:
        - path: app/widgets.py
    interface_contract:
      produces:
        - type: function
          name: create_widget
          spec: "(body: dict) -> Widget"
    verification_plan:
      a_items:
        - criterion: "POST /widgets returns 201 with valid body"
          type: command
          command: "pytest tests/test_widgets.py -k test_create_ok"
      s_items:
        - criterion: "POST /widgets returns 422 on missing field"
          test_file: tests/test_widgets.py
          test_command: "pytest tests/test_widgets.py -k test_missing_field"
          expected_exit: 0
`);
    writeTestAgentBriefs(dir);
    const text = readFileSync(
      join(dir, '.mpl', 'mpl', 'phases', 'phase-canonical', 'test-agent-brief.yaml'),
      'utf-8',
    );
    // Round-trip through the #224 validator.
    const { valid, errors } = validateBrief(text, { phaseId: 'phase-canonical' });
    assert.equal(valid, true, `brief should be valid, errors: ${errors.join(', ')}`);
    // interface_contracts derived from name/spec
    assert.match(text, /interface_contracts:[\s\S]*symbol: "create_widget"/);
    // A/S coverage: id synthesized, statement comes from criterion
    assert.match(text, /a_item_coverage:[\s\S]*A-1[\s\S]*POST \/widgets returns 201/);
    assert.match(text, /s_item_coverage:[\s\S]*S-1[\s\S]*POST \/widgets returns 422/);
    // required_test_commands sourced from the decomposer's test_command,
    // not the language default (pytest with -k filter would not be emitted
    // by the language-default path)
    assert.match(text, /required_test_commands:[\s\S]*pytest tests\/test_widgets\.py -k test_missing_field/);
    assert.match(text, /required_test_commands:[\s\S]*pytest tests\/test_widgets\.py -k test_create_ok/);
  }));

  it('codex r4 [security]: shell-quoted commands DO NOT round-trip — fail-closed under r5 policy', () => withTmp((dir) => {
    // Pre-r4: `.replace(/['"]/g, '')` destroyed inner quotes, turning
    // `pytest -k 'login; touch /tmp/pwn'` into an executable compound
    // command. Initial r4 fix preserved inner quotes via stripScalar
    // AND used a quote-aware scanner.
    //
    // Codex r5 showed the quote-aware scanner could be bypassed with
    // escaped quotes (\\'), so the policy escalated to: reject any
    // command containing `;`, `&&`, `||`, backticks, or `$(`
    // ANYWHERE. The test command falls back to the language default.
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-quoted
    phase_lang: python
    phase_domain: api
    test_agent_required: true
    impact:
      modify:
        - path: app/widgets.py
    interface_contract:
      produces:
        - type: function
          name: f
          spec: "() -> int"
    verification_plan:
      a_items:
        - criterion: "valid input"
          type: command
          command: "pytest -k 'login; touch /tmp/pwn'"
      s_items:
        - criterion: "invalid input"
          test_file: tests/test_widgets.py
          test_command: "pytest -k 'login; touch /tmp/pwn'"
`);
    writeTestAgentBriefs(dir);
    const text = readFileSync(
      join(dir, '.mpl', 'mpl', 'phases', 'phase-quoted', 'test-agent-brief.yaml'),
      'utf-8',
    );
    const cmdSection = text.match(/required_test_commands:\s*\n((?:\s+-.*\n)+)/);
    assert.ok(cmdSection, 'required_test_commands section must exist');
    // Both inner-`;`-bearing commands are rejected, regardless of quoting.
    assert.doesNotMatch(cmdSection[1], /touch \/tmp\/pwn/);
    // Falls back to language default — exact: pytest with the safe path.
    assert.match(cmdSection[1], /^\s+-\s+"pytest app\/widgets\.py"/m);
  }));

  it('codex r5 [security]: escaped-quote bypass is caught (no quote-state tracking)', () => withTmp((dir) => {
    // The r4 quote-aware scanner toggled inSingle on every `'`, including
    // escaped `\\'`. The shell treats `\\'` outside any quoted region as
    // a literal `'`, NOT as the opening of a quoted segment — so the
    // trailing `;` is a real statement separator. The r5 policy drops
    // quote tracking entirely: any `;` anywhere → reject.
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-escbypass
    phase_lang: python
    phase_domain: api
    test_agent_required: true
    impact:
      modify:
        - path: app/widgets.py
    interface_contract:
      produces:
        - type: function
          name: f
          spec: "() -> int"
    verification_plan:
      a_items:
        - criterion: "valid"
          type: command
          command: "pytest -k \\\\'; printf PWNED"
      s_items:
        - criterion: "invalid"
          test_file: tests/x.py
          test_command: "pytest -k \\\\'; printf PWNED"
`);
    writeTestAgentBriefs(dir);
    const text = readFileSync(
      join(dir, '.mpl', 'mpl', 'phases', 'phase-escbypass', 'test-agent-brief.yaml'),
      'utf-8',
    );
    const cmdSection = text.match(/required_test_commands:\s*\n((?:\s+-.*\n)+)/);
    assert.ok(cmdSection);
    assert.doesNotMatch(cmdSection[1], /PWNED/);
    assert.doesNotMatch(cmdSection[1], /printf/);
    assert.match(cmdSection[1], /^\s+-\s+"pytest app\/widgets\.py"/m);
  }));

  it('codex r4 [security]: a decomposer command with bare `;` injection is dropped, not emitted', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-bare-inject
    phase_lang: python
    phase_domain: api
    test_agent_required: true
    impact:
      modify:
        - path: app/widgets.py
    interface_contract:
      produces:
        - type: function
          name: f
          spec: "() -> int"
    verification_plan:
      a_items:
        - criterion: "valid input"
          type: command
          command: "pytest tests/x.py; touch /tmp/pwn"
      s_items:
        - criterion: "invalid"
          test_file: tests/x.py
          test_command: "pytest tests/x.py && rm -rf /"
`);
    writeTestAgentBriefs(dir);
    const text = readFileSync(
      join(dir, '.mpl', 'mpl', 'phases', 'phase-bare-inject', 'test-agent-brief.yaml'),
      'utf-8',
    );
    const cmdSection = text.match(/required_test_commands:\s*\n((?:\s+-.*\n)+)/);
    assert.ok(cmdSection);
    // Both decomposer commands are rejected (bare ; and bare &&).
    // Fall-back to language default (`pytest`) since no usable command survived.
    assert.doesNotMatch(cmdSection[1], /touch \/tmp\/pwn/);
    assert.doesNotMatch(cmdSection[1], /rm -rf/);
    assert.match(cmdSection[1], /^\s+-\s+"pytest/m);
  }));

  it('codex r1 [security]: a path with shell metacharacters is dropped from the command, not interpolated', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-evil
    phase_lang: typescript
    phase_domain: api
    test_agent_required: true
    impact:
      modify:
        - path: "src/x.ts; touch /tmp/pwn"
    interface_contract:
      produces:
        - symbol: f
          path: "src/x.ts; touch /tmp/pwn"
    verification_plan:
      a_items:
        - id: A-1
          statement: "f returns 1"
      s_items:
        - id: S-1
          statement: "f handles 0"
`);
    writeTestAgentBriefs(dir);
    const text = readFileSync(
      join(dir, '.mpl', 'mpl', 'phases', 'phase-evil', 'test-agent-brief.yaml'),
      'utf-8',
    );
    // The injected metacharacters MUST NOT be interpolated into
    // required_test_commands. Fall-back to plain `npm test` (no path
    // interpolation) is the correct shape. Path may still appear in
    // YAML data fields (target_implementation_files, interface_contracts)
    // — those are data, not commands.
    const cmdSection = text.match(/required_test_commands:\s*\n((?:\s+-.*\n)+)/);
    assert.ok(cmdSection, 'required_test_commands section must exist');
    assert.match(cmdSection[1], /^\s+-\s+"npm test"\s*$/m);
    assert.doesNotMatch(cmdSection[1], /touch \/tmp\/pwn/);
    assert.doesNotMatch(cmdSection[1], /;/);
  }));

  it('codex r2 [logic]: brief-write I/O failure surfaces as a distinct blocked_hook (not silently swallowed)', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-1
    phase_lang: typescript
    phase_domain: api
    test_agent_required: true
    impact:
      modify:
        - path: src/api/widgets.ts
    interface_contract:
      produces:
        - symbol: createWidget
          path: src/api/widgets.ts
    verification_plan:
      a_items:
        - id: A-1
          statement: "POST /widgets returns 201"
      s_items:
        - id: S-1
          statement: "POST /widgets returns 422"
`);
    // Make the briefs directory unwritable to force a write failure.
    mkdirSync(join(dir, '.mpl', 'mpl', 'phases'), { recursive: true });
    spawnSync('chmod', ['-w', join(dir, '.mpl', 'mpl', 'phases')], { encoding: 'utf-8' });
    let result;
    try {
      const input = {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        cwd: dir,
        tool_input: { file_path: '.mpl/mpl/decomposition.yaml' },
      };
      result = spawnSync(process.execPath, [join(ROOT, 'hooks', 'mpl-decomposition-postprocess.mjs')], {
        cwd: dir,
        input: JSON.stringify(input),
        encoding: 'utf-8',
      });
    } finally {
      spawnSync('chmod', ['+w', join(dir, '.mpl', 'mpl', 'phases')], { encoding: 'utf-8' });
    }
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.continue, false);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /per-phase test-agent briefs/);
    // decomposition-derived.json should still have been written
    // before the briefs step ran — derivation succeeds; only the
    // briefs step fails.
    const derivedExists = existsSync(join(dir, '.mpl', 'mpl', 'decomposition-derived.json'));
    assert.equal(derivedExists, true, 'decomposition-derived.json should still be written');
  }));

  it('non-typescript phase derives an appropriate test command (python → pytest)', () => withTmp((dir) => {
    writeActiveState(dir);
    writeDesignIntent(dir);
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-py
    phase_lang: python
    phase_domain: data
    test_agent_required: true
    impact:
      modify:
        - path: app/transform.py
    interface_contract:
      produces:
        - symbol: transform
          path: app/transform.py
    verification_plan:
      a_items:
        - id: A-1
          statement: "transform handles empty input"
      s_items:
        - id: S-1
          statement: "transform raises on malformed input"
`);
    writeTestAgentBriefs(dir);
    const text = readFileSync(
      join(dir, '.mpl', 'mpl', 'phases', 'phase-py', 'test-agent-brief.yaml'),
      'utf-8',
    );
    assert.match(text, /required_test_commands:\s*\n\s*-\s+"pytest app\/transform\.py"/);
  }));
});
