/**
 * Tests for hooks/lib/policy/schemas-config.mjs (Move P3 #6 Pass 1).
 *
 * Validates the loader contract:
 *   1. Empty / absent config -> getters return frozen fallback (byte-identical
 *      to legacy behavior).
 *   2. YAML override with new pattern -> detectUcLeakage picks it up.
 *   3. YAML override with new agent -> handleAgentOutputSchema validates it;
 *      existing agents unaffected.
 *   4. Malformed regex -> silent fallback (no throw, no crash).
 *   5. phase_seed_required.enabled:false -> spec.enabled is false (validateSeed
 *      keeps using inline control flow).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  getUcSchemaPatterns,
  getValidateAgents,
  getExpectedSections,
  getPropertyAuditTargets,
  getPhaseSeedRequiredSpec,
  __clearSchemasConfigCacheForTesting,
} from '../lib/policy/schemas-config.mjs';
import {
  UC_SCHEMA_PATTERNS,
  VALIDATE_AGENTS,
  EXPECTED_SECTIONS,
  DEFAULT_CONFIG_TARGETS,
  detectUcLeakage,
  handleAgentOutputSchema,
} from '../lib/policy/schemas.mjs';
import { __clearCacheForTesting as __clearConfigCacheForTesting } from '../lib/config.mjs';

function freshWorkspace(yamlBody) {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-policy-schemas-cfg-'));
  if (yamlBody !== undefined) {
    writeFileSync(join(dir, 'mpl.config.yaml'), yamlBody);
  }
  mkdirSync(join(dir, '.mpl'), { recursive: true });
  writeFileSync(join(dir, '.mpl', 'state.json'), JSON.stringify({
    schema_version: 2,
    current_phase: 'phase2-sprint',
  }));
  return dir;
}

beforeEach(() => {
  __clearSchemasConfigCacheForTesting();
  __clearConfigCacheForTesting();
});

// ---------------------------------------------------------------------------
// (1) Empty config -> frozen fallback
// ---------------------------------------------------------------------------

describe('empty / absent schemas.rules', () => {
  it('getUcSchemaPatterns returns UC_SCHEMA_PATTERNS fallback', () => {
    const dir = freshWorkspace('version: 2\nschemas:\n  rules: []\n');
    try {
      const patterns = getUcSchemaPatterns(dir);
      assert.strictEqual(patterns, UC_SCHEMA_PATTERNS,
        'empty rules -> exact frozen fallback reference');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getValidateAgents + getExpectedSections return frozen fallback', () => {
    const dir = freshWorkspace('version: 2\nschemas:\n  rules: []\n');
    try {
      assert.strictEqual(getValidateAgents(dir), VALIDATE_AGENTS);
      assert.strictEqual(getExpectedSections(dir), EXPECTED_SECTIONS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getPropertyAuditTargets returns DEFAULT_CONFIG_TARGETS fallback', () => {
    const dir = freshWorkspace('version: 2\nschemas:\n  rules: []\n');
    try {
      assert.strictEqual(getPropertyAuditTargets(dir), DEFAULT_CONFIG_TARGETS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getPhaseSeedRequiredSpec returns enabled:false when rule is absent', () => {
    const dir = freshWorkspace('version: 2\nschemas:\n  rules: []\n');
    try {
      const spec = getPhaseSeedRequiredSpec(dir);
      assert.strictEqual(spec.enabled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (2) pp_uc_leakage override adds a new pattern
// ---------------------------------------------------------------------------

describe('pp_uc_leakage YAML override', () => {
  it('extra pattern is picked up by detectUcLeakage', () => {
    const yaml = `version: 2
schemas:
  rules:
    pp_uc_leakage:
      kind: regex_denylist
      target: '.mpl/pivot-points.md'
      patterns:
        - name: 'user_cases:'
          re: '^user_cases\\s*:'
          flags: 'm'
        - name: 'CUSTOM_MARKER'
          re: 'CUSTOM-FORBIDDEN-TOKEN'
          flags: ''
`;
    const dir = freshWorkspace(yaml);
    try {
      const patterns = getUcSchemaPatterns(dir);
      assert.notStrictEqual(patterns, UC_SCHEMA_PATTERNS,
        'override -> distinct array reference');
      const hits = detectUcLeakage(
        'some body containing CUSTOM-FORBIDDEN-TOKEN here',
        patterns,
      );
      assert.ok(hits.some((h) => h.name === 'CUSTOM_MARKER'),
        'custom pattern fires on matching content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed regex falls back silently (no throw, frozen behavior preserved)', () => {
    const yaml = `version: 2
schemas:
  rules:
    pp_uc_leakage:
      kind: regex_denylist
      target: '.mpl/pivot-points.md'
      patterns:
        - name: 'broken'
          re: '('
          flags: ''
`;
    const dir = freshWorkspace(yaml);
    try {
      // All patterns invalid -> total fallback to frozen.
      const patterns = getUcSchemaPatterns(dir);
      assert.strictEqual(patterns, UC_SCHEMA_PATTERNS,
        'fully-malformed override -> frozen fallback');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (3) agent_output_sections override adds a new agent
// ---------------------------------------------------------------------------

describe('agent_output_sections YAML override', () => {
  it('new agent gets validated; existing agents untouched', () => {
    const yaml = `version: 2
schemas:
  rules:
    agent_output_sections:
      kind: section_presence
      match: case_insensitive_substring
      agents:
        mpl-phase-runner:
          - status
          - state_summary
          - verification
        mpl-custom-agent:
          - intro
          - outro
`;
    const dir = freshWorkspace(yaml);
    try {
      const agents = getValidateAgents(dir);
      assert.ok(agents.has('mpl-custom-agent'), 'custom agent registered');
      assert.ok(agents.has('mpl-phase-runner'), 'override list re-declares phase-runner');
      const sections = getExpectedSections(dir);
      assert.deepEqual([...sections['mpl-custom-agent']], ['intro', 'outro']);

      // handleAgentOutputSchema picks up the custom agent.
      const blocked = handleAgentOutputSchema({
        toolName: 'Task',
        toolInput: { subagent_type: 'mpl-custom-agent' },
        toolResponse: 'no relevant sections here',
        cwd: dir,
        mplActive: true,
      });
      assert.equal(blocked.action, 'block');
      assert.equal(blocked.ruleId, 'agent_output_sections_missing');

      // A non-listed agent stays out of the validator surface.
      const allowed = handleAgentOutputSchema({
        toolName: 'Task',
        toolInput: { subagent_type: 'mpl-doctor' },
        toolResponse: 'unrelated text',
        cwd: dir,
        mplActive: true,
      });
      assert.equal(allowed.action, 'allow');
      assert.equal(allowed.ruleId, 'agent_output_not_validated_agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (4) phase_seed_required.enabled:false -> validateSeed behavior unchanged
// ---------------------------------------------------------------------------

describe('phase_seed_required Pass-3 gating', () => {
  it('enabled:false leaves the spec dormant', () => {
    const yaml = `version: 2
schemas:
  rules:
    phase_seed_required:
      kind: yaml_field_required
      enabled: false
      always: []
      per_todo: []
      conditional: []
`;
    const dir = freshWorkspace(yaml);
    try {
      const spec = getPhaseSeedRequiredSpec(dir);
      assert.equal(spec.enabled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enabled:true exposes the spec for a future dispatcher', () => {
    const yaml = `version: 2
schemas:
  rules:
    phase_seed_required:
      kind: yaml_field_required
      enabled: true
      always:
        - path: phase_seed.goal
          check: nonEmptyString
      per_todo: []
      conditional: []
`;
    const dir = freshWorkspace(yaml);
    try {
      const spec = getPhaseSeedRequiredSpec(dir);
      assert.equal(spec.enabled, true);
      assert.equal(spec.raw.kind, 'yaml_field_required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (5) property_audit_targets override / fallback
// ---------------------------------------------------------------------------

describe('property_audit_targets YAML override', () => {
  it('empty paths -> frozen fallback', () => {
    const yaml = `version: 2
schemas:
  rules:
    property_audit_targets:
      kind: config_target_list
      paths: []
`;
    const dir = freshWorkspace(yaml);
    try {
      assert.strictEqual(getPropertyAuditTargets(dir), DEFAULT_CONFIG_TARGETS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-empty paths -> overrides used verbatim', () => {
    const yaml = `version: 2
schemas:
  rules:
    property_audit_targets:
      kind: config_target_list
      paths:
        - .mpl/state.json
        - .mpl/config.json
`;
    const dir = freshWorkspace(yaml);
    try {
      const paths = getPropertyAuditTargets(dir);
      assert.notStrictEqual(paths, DEFAULT_CONFIG_TARGETS);
      assert.deepEqual([...paths], ['.mpl/state.json', '.mpl/config.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
