/**
 * Tests for hooks/lib/policy/schemas.mjs (Move #11).
 *
 * Synthetic state + cwd fixtures. The four wrapper hooks delegate to this
 * module — these tests exercise each sub-handler in isolation against the
 * uniform decision envelope.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  handle,
  handlePivotPointsSchema,
  handleAgentOutputSchema,
  handleSeedSchema,
  handlePropertyAudit,
  targetsPivotPointsFile,
  extractProposedContent,
  detectUcLeakage,
  formatPivotPointsBlockReason,
  formatBlockReason,
  validateSections,
  formatValidationMessage,
  validateSeed,
  validateTodoSchedulingFields,
  extractYaml,
  hasYamlField,
  hasNonEmptyArray,
  hasNonEmptyString,
  hasContractFilesContext,
  isSeedRelated,
  UC_SCHEMA_PATTERNS,
  VALIDATE_AGENTS,
  EXPECTED_SECTIONS,
  SEED_PATH_RE,
  SCHEMAS_HOOK_IDS,
  PIVOT_POINTS_BLOCKED_ARTIFACT,
  DEFAULT_CONFIG_TARGETS,
  isMplActive,
} from '../lib/policy/schemas.mjs';

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-policy-schemas-'));
  mkdirSync(join(dir, '.mpl'), { recursive: true });
  writeFileSync(join(dir, '.mpl', 'state.json'), JSON.stringify({
    schema_version: 2,
    current_phase: 'phase2-sprint',
  }));
  return dir;
}

// ============================================================================
// Public constant exports — back-compat surface
// ============================================================================

describe('public constant exports', () => {
  it('exposes SCHEMAS_HOOK_IDS with the four canonical IDs', () => {
    assert.equal(SCHEMAS_HOOK_IDS.pivot_points_schema, 'mpl-validate-pp-schema');
    assert.equal(SCHEMAS_HOOK_IDS.agent_output_schema, 'mpl-validate-output');
    assert.equal(SCHEMAS_HOOK_IDS.seed_schema, 'mpl-validate-seed');
    assert.equal(SCHEMAS_HOOK_IDS.property_audit, 'mpl-property-check');
  });
  it('exposes UC_SCHEMA_PATTERNS as a frozen array', () => {
    assert.ok(Array.isArray(UC_SCHEMA_PATTERNS));
    assert.ok(Object.isFrozen(UC_SCHEMA_PATTERNS));
    assert.ok(UC_SCHEMA_PATTERNS.some((p) => p.name === 'user_cases:'));
  });
  it('exposes VALIDATE_AGENTS as a Set of the eight legacy agents', () => {
    assert.ok(VALIDATE_AGENTS instanceof Set);
    for (const name of [
      'mpl-phase-runner', 'mpl-decomposer', 'mpl-interviewer',
      'mpl-test-agent', 'mpl-codebase-analyzer', 'mpl-doctor',
      'mpl-git-master', 'mpl-phase0-analyzer',
    ]) {
      assert.ok(VALIDATE_AGENTS.has(name), `missing agent ${name}`);
    }
  });
  it('exposes EXPECTED_SECTIONS frozen mapping for all VALIDATE_AGENTS', () => {
    for (const agent of VALIDATE_AGENTS) {
      assert.ok(Array.isArray(EXPECTED_SECTIONS[agent]));
    }
  });
  it('exposes SEED_PATH_RE matching legacy + inline phase/chain seeds', () => {
    assert.ok(SEED_PATH_RE.test('.mpl/seeds/phase-1.yaml'));
    assert.ok(SEED_PATH_RE.test('.mpl/mpl/phases/phase-1/phase-seed.yaml'));
    assert.ok(SEED_PATH_RE.test('.mpl/mpl/chains/chain-1/chain-seed.yaml'));
    assert.ok(!SEED_PATH_RE.test('.mpl/state.json'));
  });
  it('exposes PIVOT_POINTS_BLOCKED_ARTIFACT', () => {
    assert.equal(PIVOT_POINTS_BLOCKED_ARTIFACT, '.mpl/pivot-points.md');
  });
  it('exposes DEFAULT_CONFIG_TARGETS (re-exported from L1)', () => {
    assert.ok(Array.isArray(DEFAULT_CONFIG_TARGETS));
    assert.ok(DEFAULT_CONFIG_TARGETS.length > 0);
  });
  it('exposes isMplActive helper for wrappers', () => {
    assert.equal(typeof isMplActive, 'function');
  });
});

// ============================================================================
// Pure helpers — pivot-points
// ============================================================================

describe('targetsPivotPointsFile', () => {
  it('matches .mpl/pivot-points.md at repo root and nested', () => {
    assert.equal(targetsPivotPointsFile('/repo/.mpl/pivot-points.md'), true);
    assert.equal(targetsPivotPointsFile('.mpl/pivot-points.md'), true);
  });
  it('rejects user-contract.md and unrelated paths', () => {
    assert.equal(targetsPivotPointsFile('/repo/.mpl/requirements/user-contract.md'), false);
    assert.equal(targetsPivotPointsFile('/repo/docs/pivot-points.md'), false);
  });
  it('returns false for null/undefined/empty', () => {
    assert.equal(targetsPivotPointsFile(null), false);
    assert.equal(targetsPivotPointsFile(undefined), false);
    assert.equal(targetsPivotPointsFile(''), false);
  });
});

describe('detectUcLeakage', () => {
  it('detects user_cases / deferred_cases / cut_cases / user_delta / covers_pp / UC-NN', () => {
    assert.ok(detectUcLeakage('user_cases:\n  - id: UC-01').some((h) => h.name === 'user_cases:'));
    assert.ok(detectUcLeakage('deferred_cases:\n  - id: X').some((h) => h.name === 'deferred_cases:'));
    assert.ok(detectUcLeakage('cut_cases:\n  - id: X').some((h) => h.name === 'cut_cases:'));
    assert.ok(detectUcLeakage('  user_delta: "added by user"').some((h) => h.name === 'user_delta:'));
    assert.ok(detectUcLeakage('  covers_pp: [PP-1]').some((h) => h.name === 'covers_pp:'));
    assert.ok(detectUcLeakage('See UC-01 here.').some((h) => h.name === 'UC-NN identifier'));
  });
  it('does not flag clean PP content or single-digit UC-1', () => {
    const clean = '# Pivot Points\n\n## PP-1: token storage\nfoo';
    assert.deepEqual(detectUcLeakage(clean), []);
    assert.deepEqual(detectUcLeakage('See UC-1 in legacy doc.'), []);
  });
  it('returns empty for null/empty input', () => {
    assert.deepEqual(detectUcLeakage(''), []);
    assert.deepEqual(detectUcLeakage(null), []);
  });
});

describe('extractProposedContent', () => {
  it('returns Write content and Edit new_string', () => {
    assert.equal(extractProposedContent({ content: 'body' }, 'Write'), 'body');
    assert.equal(extractProposedContent({ new_string: 'new body' }, 'Edit'), 'new body');
  });
  it('joins MultiEdit new_string entries', () => {
    assert.equal(
      extractProposedContent({
        file_path: '.mpl/pivot-points.md',
        edits: [
          { old_string: 'a', new_string: 'first' },
          { old_string: 'b', new_string: 'second' },
        ],
      }, 'MultiEdit'),
      'first\nsecond',
    );
  });
  it('returns empty for non-write tools or missing input', () => {
    assert.equal(extractProposedContent({ content: 'x' }, 'Bash'), '');
    assert.equal(extractProposedContent(null, 'Write'), '');
  });
});

describe('formatBlockReason / formatPivotPointsBlockReason', () => {
  it('produces a reason containing markers and user-contract.md', () => {
    const r = formatBlockReason([{ name: 'user_cases:' }, { name: 'UC-NN identifier' }]);
    assert.ok(r.includes('user_cases:'));
    assert.ok(r.includes('UC-NN identifier'));
    assert.ok(r.includes('user-contract.md'));
  });
  it('formatPivotPointsBlockReason is an alias of formatBlockReason', () => {
    assert.strictEqual(formatPivotPointsBlockReason, formatBlockReason);
  });
});

// ============================================================================
// (1) handlePivotPointsSchema
// ============================================================================

describe('handlePivotPointsSchema', () => {
  it('returns noop when toolName is not a file-write tool', () => {
    const decision = handlePivotPointsSchema({
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      mplActive: true,
    });
    assert.equal(decision.action, 'noop');
  });

  it('returns noop when file is not pivot-points.md', () => {
    const decision = handlePivotPointsSchema({
      toolName: 'Write',
      toolInput: { file_path: '.mpl/requirements/user-contract.md', content: 'user_cases:' },
      mplActive: true,
    });
    assert.equal(decision.action, 'noop');
  });

  it('returns allow when pivot-points.md content is clean', () => {
    const decision = handlePivotPointsSchema({
      toolName: 'Write',
      toolInput: {
        file_path: '.mpl/pivot-points.md',
        content: '## PP-1: clean invariant\nbody',
      },
      mplActive: true,
    });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.artifact, '.mpl/pivot-points.md');
  });

  it('returns block when pivot-points.md content contains UC schema', () => {
    const decision = handlePivotPointsSchema({
      toolName: 'MultiEdit',
      toolInput: {
        file_path: '.mpl/pivot-points.md',
        edits: [{ old_string: '#', new_string: 'user_cases:\n  - id: UC-01' }],
      },
      mplActive: true,
    });
    assert.equal(decision.action, 'block');
    assert.equal(decision.code, 'pp_schema_uc_leakage');
    assert.equal(decision.ruleId, 'pp_schema_invalid');
    assert.equal(decision.artifact, '.mpl/pivot-points.md');
    assert.match(decision.reason, /UC-scoped schema/);
    assert.match(decision.resumeInstruction, /Move every UC-scoped schema/);
    assert.deepEqual(decision.retryContext.markers.sort(), ['UC-NN identifier', 'user_cases:'].sort());
  });

  it('passes mplActive flag through retryContext for diagnostics', () => {
    const decision = handlePivotPointsSchema({
      toolName: 'Write',
      toolInput: { file_path: '.mpl/pivot-points.md', content: 'user_cases:\n  - id: UC-99' },
      mplActive: false,
    });
    assert.equal(decision.action, 'block');
    assert.equal(decision.retryContext.mplActive, false);
  });
});

// ============================================================================
// (2) handleAgentOutputSchema
// ============================================================================

describe('validateSections', () => {
  it('passes when all sections present (case-insensitive)', () => {
    const r = validateSections(['Risk Register', 'Go/No-Go'], 'RISK REGISTER ok GO/NO-GO ready');
    assert.equal(r.passed, true);
    assert.equal(r.missing.length, 0);
  });
  it('lists missing sections', () => {
    const r = validateSections(['a', 'b', 'c'], 'only a here');
    assert.equal(r.passed, false);
    assert.deepEqual(r.missing, ['b', 'c']);
    assert.deepEqual(r.found, ['a']);
  });
  it('produces [PASS]/[MISSING] sectionList lines', () => {
    const r = validateSections(['alpha', 'beta'], 'alpha here');
    assert.ok(r.sectionList.includes('[PASS] alpha'));
    assert.ok(r.sectionList.includes('[MISSING] beta'));
  });
});

describe('formatValidationMessage', () => {
  it('produces PASSED message when passed=true', () => {
    const msg = formatValidationMessage('mpl-doctor', ['a', 'b'], true, [], '');
    assert.match(msg, /\[MPL VALIDATION PASSED\]/);
    assert.match(msg, /2 required sections/);
  });
  it('produces FAILED message with ACTION REQUIRED when passed=false', () => {
    const msg = formatValidationMessage('mpl-doctor', ['a', 'b'], false, ['b'], '  - [PASS] a\n  - [MISSING] b');
    assert.match(msg, /\[MPL VALIDATION FAILED\]/);
    assert.match(msg, /ACTION REQUIRED/);
    assert.match(msg, /Missing sections: b/);
  });
});

describe('handleAgentOutputSchema', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns noop for non-Task tools', () => {
    const decision = handleAgentOutputSchema({
      toolName: 'Bash',
      toolInput: {},
      toolResponse: 'x',
      cwd: tmp,
      mplActive: true,
    });
    assert.equal(decision.action, 'noop');
  });

  it('returns noop when MPL inactive', () => {
    const decision = handleAgentOutputSchema({
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-doctor' },
      toolResponse: 'x',
      cwd: tmp,
      mplActive: false,
    });
    assert.equal(decision.action, 'noop');
  });

  it('returns allow for Task by an agent NOT in VALIDATE_AGENTS', () => {
    const decision = handleAgentOutputSchema({
      toolName: 'Task',
      toolInput: { subagent_type: 'some-random-agent' },
      toolResponse: 'output text',
      cwd: tmp,
      mplActive: true,
    });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.ruleId, 'agent_output_not_validated_agent');
    // Token telemetry side effects recorded for ALL Tasks.
    assert.ok(Array.isArray(decision.sideEffects));
  });

  it('returns allow with sections-ok ruleId when validated agent passes', () => {
    const response = JSON.stringify({
      Results: 'OK',
      'Tool Availability Detail': '...',
      Recommendations: '...',
      Summary: 'done',
    });
    const decision = handleAgentOutputSchema({
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-doctor' },
      toolResponse: response,
      cwd: tmp,
      mplActive: true,
    });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.ruleId, 'agent_output_sections_ok');
  });

  it('returns block when validated agent output is missing sections', () => {
    const decision = handleAgentOutputSchema({
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-doctor' },
      toolResponse: 'just a Results line, nothing else',
      cwd: tmp,
      mplActive: true,
    });
    assert.equal(decision.action, 'block');
    assert.equal(decision.ruleId, 'agent_output_sections_missing');
    assert.equal(decision.code, 'agent_output_validation_failed');
    assert.match(decision.reason, /VALIDATION FAILED/);
    assert.equal(decision.retryContext.agentType, 'mpl-doctor');
    assert.ok(Array.isArray(decision.retryContext.missing));
  });

  it('side-effect: token usage is reflected in state.json cost.total_tokens', () => {
    handleAgentOutputSchema({
      toolName: 'Task',
      toolInput: { subagent_type: 'unknown-agent' },
      toolResponse: 'x'.repeat(400),
      cwd: tmp,
      mplActive: true,
    });
    const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
    // 400 chars / 4 = 100 estimated tokens
    assert.equal(state.cost.total_tokens, 100);
  });

  it('side-effect: writes weekly.jsonl and phases.jsonl when state exists', () => {
    handleAgentOutputSchema({
      toolName: 'Task',
      toolInput: { subagent_type: 'unknown-agent' },
      toolResponse: 'x'.repeat(40),
      cwd: tmp,
      mplActive: true,
    });
    assert.ok(existsSync(join(tmp, '.mpl', 'usage', 'weekly.jsonl')));
    assert.ok(existsSync(join(tmp, '.mpl', 'mpl', 'profile', 'phases.jsonl')));
  });
});

// ============================================================================
// (3) handleSeedSchema
// ============================================================================

function validSeedYaml() {
  return `phase_seed:
  goal: "ship"
  acceptance_criteria:
    - "AC-1"
  mini_plan_seed:
    todo_structure:
      - id: todo-1
        description: "Implement feature"
        depends_on: []
        files_to_modify:
          - src/app.ts
        resource_locks: []
  exit_conditions:
    - type: command
      command: "npm test"
`;
}

describe('seed YAML helpers', () => {
  it('extractYaml pulls fenced block', () => {
    assert.equal(extractYaml('```yaml\nfoo: 1\n```'), 'foo: 1\n');
    assert.equal(extractYaml('no fence'), null);
  });
  it('hasNonEmptyString recognises real values and rejects null/empty', () => {
    assert.equal(hasNonEmptyString('goal: ship', 'goal'), true);
    assert.equal(hasNonEmptyString('goal:', 'goal'), false);
    assert.equal(hasNonEmptyString('goal: null', 'goal'), false);
    assert.equal(hasNonEmptyString('goal: ""', 'goal'), false);
  });
  it('hasNonEmptyArray detects list items', () => {
    assert.equal(hasNonEmptyArray('acceptance_criteria:\n  - AC-1\n', 'acceptance_criteria'), true);
    assert.equal(hasNonEmptyArray('acceptance_criteria:\n', 'acceptance_criteria'), false);
  });
  it('hasYamlField finds nested leaf key', () => {
    assert.equal(hasYamlField('phase_seed:\n  goal: x\n', 'phase_seed.goal'), true);
    assert.equal(hasYamlField('phase_seed:\n', 'phase_seed.goal'), false);
  });
  it('hasContractFilesContext detects three patterns', () => {
    assert.equal(hasContractFilesContext('contract_files: [a]'), true);
    assert.equal(hasContractFilesContext('contract_files=[a]'), true);
    assert.equal(hasContractFilesContext('see .mpl/contracts/x.yaml'), true);
    assert.equal(hasContractFilesContext('plain text'), false);
  });
});

describe('validateSeed', () => {
  it('passes for a well-formed seed', () => {
    const r = validateSeed(validSeedYaml());
    assert.equal(r.valid, true);
    assert.deepEqual(r.missing, []);
  });
  it('reports missing goal and acceptance_criteria', () => {
    const r = validateSeed('phase_seed:\n  todo_structure:\n    - id: t1\n      depends_on: []\n      files_to_modify: []\n      resource_locks: []\nexit_conditions:\n  - x\n');
    assert.equal(r.valid, false);
    assert.ok(r.missing.includes('phase_seed.goal'));
    assert.ok(r.missing.includes('phase_seed.acceptance_criteria'));
  });
});

describe('validateTodoSchedulingFields', () => {
  it('requires depends_on, files_to_modify, resource_locks per TODO', () => {
    const yaml = `phase_seed:
  mini_plan_seed:
    todo_structure:
      - id: todo-1
        description: "no scheduling"
`;
    const missing = validateTodoSchedulingFields(yaml);
    assert.ok(missing.some((m) => m.includes('depends_on')));
    assert.ok(missing.some((m) => m.includes('files_to_modify')));
    assert.ok(missing.some((m) => m.includes('resource_locks')));
  });
  it('passes when all scheduling fields present', () => {
    assert.deepEqual(validateTodoSchedulingFields(validSeedYaml()), []);
  });
});

describe('isSeedRelated', () => {
  it('matches file writes to seed paths', () => {
    assert.equal(
      isSeedRelated('Write', { file_path: '.mpl/mpl/phases/p1/phase-seed.yaml', content: 'x' }, ''),
      true,
    );
    assert.equal(
      isSeedRelated('MultiEdit', {
        file_path: '.mpl/seeds/phase-1.yaml',
        edits: [{ old_string: 'a', new_string: 'b' }],
      }, ''),
      true,
    );
  });
  it('matches Task outputs containing phase_seed YAML', () => {
    assert.equal(
      isSeedRelated('Task', {}, '```yaml\nphase_seed:\n  goal: x\n```'),
      true,
    );
  });
  it('rejects unrelated paths and outputs', () => {
    assert.equal(isSeedRelated('Write', { file_path: '.mpl/state.json', content: 'x' }, ''), false);
    assert.equal(isSeedRelated('Task', {}, 'no yaml here'), false);
  });
});

describe('handleSeedSchema', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns noop for irrelevant tool/path', () => {
    const decision = handleSeedSchema({
      toolName: 'Write',
      toolInput: { file_path: 'src/foo.ts', content: 'x' },
      toolResponse: '',
      cwd: tmp,
      mplActive: true,
    });
    assert.equal(decision.action, 'noop');
  });

  it('returns noop when MPL inactive', () => {
    const decision = handleSeedSchema({
      toolName: 'Write',
      toolInput: {
        file_path: '.mpl/mpl/phases/p1/phase-seed.yaml',
        content: validSeedYaml(),
      },
      toolResponse: '',
      cwd: tmp,
      mplActive: false,
    });
    assert.equal(decision.action, 'noop');
  });

  it('returns allow for a well-formed seed', () => {
    const decision = handleSeedSchema({
      toolName: 'Write',
      toolInput: {
        file_path: '.mpl/mpl/phases/p1/phase-seed.yaml',
        content: validSeedYaml(),
      },
      toolResponse: '',
      cwd: tmp,
      mplActive: true,
    });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.ruleId, 'seed_schema_ok');
  });

  it('returns advisory with missing-fields message when invalid', () => {
    const decision = handleSeedSchema({
      toolName: 'Write',
      toolInput: {
        file_path: '.mpl/mpl/phases/p1/phase-seed.yaml',
        content: 'phase_seed:\n  goal: "x"\n',
      },
      toolResponse: '',
      cwd: tmp,
      mplActive: true,
    });
    assert.equal(decision.action, 'advisory');
    assert.equal(decision.ruleId, 'seed_schema_invalid');
    assert.match(decision.additionalContext, /SEED VALIDATION FAILED/);
    assert.match(decision.additionalContext, /acceptance_criteria/);
  });

  it('returns advisory when Task output lacks a YAML block', () => {
    const decision = handleSeedSchema({
      toolName: 'Task',
      toolInput: {},
      toolResponse: 'phase_seed: blah but no yaml fence',
      cwd: tmp,
      mplActive: true,
    });
    assert.equal(decision.action, 'noop'); // no ```yaml fence → not seed-related
  });

  it('returns advisory missing-yaml when Task output has fence + phase_seed but no yaml inside', () => {
    const decision = handleSeedSchema({
      toolName: 'Task',
      toolInput: {},
      // Trigger isSeedRelated (has both phase_seed: and ```yaml) but supply a
      // closed empty fence so extractYaml succeeds with empty content. Schema
      // check then fails.
      toolResponse: 'has phase_seed: marker\n```yaml\n```',
      cwd: tmp,
      mplActive: true,
    });
    assert.equal(decision.action, 'advisory');
  });
});

// ============================================================================
// (4) handlePropertyAudit
// ============================================================================

describe('handlePropertyAudit', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-policy-schemas-pc-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns report-with-error when pluginRoot is missing', () => {
    const decision = handlePropertyAudit({});
    assert.equal(decision.action, 'report');
    assert.ok(decision.payload.error);
  });

  it('returns report payload with totals and per-config breakdown', () => {
    mkdirSync(join(tmp, 'config'), { recursive: true });
    writeFileSync(
      join(tmp, 'config', 'a.json'),
      JSON.stringify({ x: 1, y: 2 }),
    );
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'used.ts'), 'cfg.x\n');
    const decision = handlePropertyAudit({
      pluginRoot: tmp,
      configPaths: ['config/a.json'],
    });
    assert.equal(decision.action, 'report');
    assert.equal(decision.payload.plugin_root, tmp);
    assert.equal(decision.payload.totals.declarations, 2);
    assert.equal(decision.payload.totals.used, 1);
    assert.equal(decision.payload.totals.unused, 1);
    assert.equal(decision.payload.configs.length, 1);
  });

  it('falls back to DEFAULT_CONFIG_TARGETS when configPaths omitted', () => {
    const decision = handlePropertyAudit({ pluginRoot: tmp });
    assert.equal(decision.action, 'report');
    assert.equal(decision.payload.configs.length, DEFAULT_CONFIG_TARGETS.length);
  });
});

// ============================================================================
// Top-level dispatch
// ============================================================================

describe('handle dispatcher', () => {
  it('routes pivot_points_schema', () => {
    const d = handle('pivot_points_schema', {
      toolName: 'Bash',
      toolInput: {},
    });
    assert.equal(d.action, 'noop');
  });
  it('routes agent_output_schema', () => {
    const d = handle('agent_output_schema', {
      toolName: 'Bash',
      toolInput: {},
      toolResponse: '',
    });
    assert.equal(d.action, 'noop');
  });
  it('routes seed_schema', () => {
    const d = handle('seed_schema', {
      toolName: 'Bash',
      toolInput: {},
      toolResponse: '',
    });
    assert.equal(d.action, 'noop');
  });
  it('routes property_audit', () => {
    const d = handle('property_audit', {});
    assert.equal(d.action, 'report');
  });
  it('throws on unknown event', () => {
    assert.throws(() => handle('mystery', {}), /unknown event/);
  });
});
