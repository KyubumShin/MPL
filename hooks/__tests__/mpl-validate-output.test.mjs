import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateSections, formatValidationMessage, VALIDATE_AGENTS, EXPECTED_SECTIONS } from '../mpl-validate-output.mjs';

// --- validateSections ---

describe('validateSections', () => {
  it('should return passed=true when all sections found', () => {
    const sections = ['todo_id', 'status', 'outputs', 'acceptance_criteria'];
    const text = '{"todo_id":"T-1","status":"PASS","outputs":{"files":[]},"acceptance_criteria":[]}';
    const result = validateSections(sections, text);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.missing.length, 0);
    assert.strictEqual(result.found.length, 4);
  });

  it('should return passed=false with correct missing list', () => {
    const sections = ['todo_id', 'status', 'outputs', 'acceptance_criteria'];
    const text = 'Here is todo_id and status only';
    const result = validateSections(sections, text);
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.missing, ['outputs', 'acceptance_criteria']);
    assert.deepStrictEqual(result.found, ['todo_id', 'status']);
  });

  it('should match case-insensitively', () => {
    const sections = ['Risk Register', 'Go/No-Go Assessment'];
    const text = 'RISK REGISTER: ... go/no-go assessment: READY';
    const result = validateSections(sections, text);
    assert.strictEqual(result.passed, true);
  });

  it('should handle empty sections list', () => {
    const result = validateSections([], 'any text');
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.missing.length, 0);
  });

  it('should handle empty response text', () => {
    const sections = ['status'];
    const result = validateSections(sections, '');
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.missing, ['status']);
  });

  it('should produce correct sectionList format', () => {
    const sections = ['A', 'B'];
    const result = validateSections(sections, 'found A here');
    assert.ok(result.sectionList.includes('[PASS] A'));
    assert.ok(result.sectionList.includes('[MISSING] B'));
  });
});

// --- formatValidationMessage ---

describe('formatValidationMessage', () => {
  it('should produce PASSED message when passed=true', () => {
    const msg = formatValidationMessage('mpl-worker', ['a', 'b'], true, [], '');
    assert.ok(msg.startsWith('[MPL VALIDATION PASSED]'));
    assert.ok(msg.includes('mpl-worker'));
    assert.ok(msg.includes('2 required sections'));
  });

  it('should produce FAILED message with [VALIDATION FAILED] prefix', () => {
    const msg = formatValidationMessage('mpl-critic', ['A', 'B', 'C'], false, ['B', 'C'], '  - [PASS] A\n  - [MISSING] B\n  - [MISSING] C');
    assert.ok(msg.startsWith('[VALIDATION FAILED]'));
    assert.ok(msg.includes('2/3'));
    assert.ok(msg.includes('B, C'));
    assert.ok(msg.includes('ACTION REQUIRED'));
  });

  it('should include agent name in both pass and fail messages', () => {
    const pass = formatValidationMessage('mpl-decomposer', ['x'], true, [], '');
    const fail = formatValidationMessage('mpl-decomposer', ['x'], false, ['x'], '');
    assert.ok(pass.includes('mpl-decomposer'));
    assert.ok(fail.includes('mpl-decomposer'));
  });
});

// --- VALIDATE_AGENTS ---

describe('VALIDATE_AGENTS', () => {
  it('should be a Set', () => {
    assert.ok(VALIDATE_AGENTS instanceof Set);
  });

  it('should contain all 11 expected agents', () => {
    const expected = [
      'mpl-pre-execution-analyzer', 'mpl-verification-planner',
      'mpl-worker', 'mpl-phase-runner', 'mpl-interviewer',
      'mpl-test-agent', 'mpl-code-reviewer', 'mpl-decomposer', 'mpl-git-master', 'mpl-compound',
      'mpl-doctor',
    ];
    assert.strictEqual(VALIDATE_AGENTS.size, 11);
    for (const agent of expected) {
      assert.ok(VALIDATE_AGENTS.has(agent), `missing: ${agent}`);
    }
  });

  it('should not contain non-existent agents', () => {
    assert.ok(!VALIDATE_AGENTS.has('mpl-research-synthesizer'));
    assert.ok(!VALIDATE_AGENTS.has('mpl-fake-agent'));
  });
});

// --- EXPECTED_SECTIONS ---

describe('EXPECTED_SECTIONS', () => {
  it('should have entries for all agents in VALIDATE_AGENTS', () => {
    for (const agent of VALIDATE_AGENTS) {
      assert.ok(Array.isArray(EXPECTED_SECTIONS[agent]), `missing sections for: ${agent}`);
      assert.ok(EXPECTED_SECTIONS[agent].length > 0, `empty sections for: ${agent}`);
    }
  });

  it('pre-execution-analyzer should have 7 sections', () => {
    assert.strictEqual(EXPECTED_SECTIONS['mpl-pre-execution-analyzer'].length, 7);
  });

  it('critic should be removed (absorbed into decomposer v3.1)', () => {
    assert.strictEqual(EXPECTED_SECTIONS['mpl-critic'], undefined);
  });

  it('worker should require todo_id, status, outputs, acceptance_criteria', () => {
    const s = EXPECTED_SECTIONS['mpl-worker'];
    assert.ok(s.includes('todo_id'));
    assert.ok(s.includes('status'));
    assert.ok(s.includes('outputs'));
    assert.ok(s.includes('acceptance_criteria'));
  });
});
