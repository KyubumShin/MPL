import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_VERSION,
  parseClassification,
  neutralResult,
} from '../dist/lib/feature-classifier.js';

describe('PROMPT_VERSION', () => {
  it('is a frozen version string', () => {
    assert.equal(typeof PROMPT_VERSION, 'string');
    assert.ok(PROMPT_VERSION.length > 0);
  });
});

describe('parseClassification', () => {
  const validPayload = {
    user_cases: [
      {
        id: 'UC-01',
        title: 'User can log in',
        user_delta: '',
        priority: 'P0',
        status: 'included',
        covers_pp: ['PP-1'],
        acceptance_hint: '',
      },
    ],
    deferred: [],
    cut: [],
    scenarios: [
      {
        id: 'SC-01',
        title: 'Login happy path',
        covers: ['UC-01'],
        covers_pp: ['PP-1'],
        steps: ['visit /login', 'enter creds', 'assert /dashboard'],
        skip_allowed: [],
      },
    ],
    pp_conflict: [],
    ambiguity_hints: [],
    next_question: null,
    convergence: true,
  };

  it('parses a valid JSON payload', () => {
    const result = parseClassification(JSON.stringify(validPayload));
    assert.ok(result);
    assert.equal(result.convergence, true);
    assert.equal(result.user_cases.length, 1);
    assert.equal(result.user_cases[0].id, 'UC-01');
    assert.equal(result.scenarios[0].id, 'SC-01');
    assert.equal(result.prompt_version, PROMPT_VERSION);
  });

  it('parses JSON embedded in surrounding text', () => {
    const wrapped = `Some preamble...\n${JSON.stringify(validPayload)}\nTrailing.`;
    const result = parseClassification(wrapped);
    assert.ok(result);
    assert.equal(result.user_cases.length, 1);
  });

  it('returns null on empty input', () => {
    assert.equal(parseClassification(''), null);
    assert.equal(parseClassification(null), null);
  });

  it('returns null when required arrays are missing', () => {
    const missingScenarios = { ...validPayload };
    delete missingScenarios.scenarios;
    assert.equal(parseClassification(JSON.stringify(missingScenarios)), null);
  });

  it('returns null when array field is not an array', () => {
    const bad = { ...validPayload, user_cases: 'not-an-array' };
    assert.equal(parseClassification(JSON.stringify(bad)), null);
  });

  it('returns null when convergence is missing or not boolean', () => {
    const noConv = { ...validPayload };
    delete noConv.convergence;
    assert.equal(parseClassification(JSON.stringify(noConv)), null);

    const badConv = { ...validPayload, convergence: 'yes' };
    assert.equal(parseClassification(JSON.stringify(badConv)), null);
  });

  it('accepts non-null next_question object', () => {
    const withQ = {
      ...validPayload,
      convergence: false,
      next_question: { kind: 'clarify', payload: { uc_id: 'UC-01' } },
    };
    const result = parseClassification(JSON.stringify(withQ));
    assert.ok(result);
    assert.equal(result.next_question.kind, 'clarify');
  });

  it('rejects malformed JSON', () => {
    assert.equal(parseClassification('{unclosed'), null);
    assert.equal(parseClassification('not json at all'), null);
  });
});

describe('neutralResult', () => {
  it('returns a structurally valid fallback', () => {
    const r = neutralResult();
    assert.equal(r.prompt_version, PROMPT_VERSION);
    assert.ok(Array.isArray(r.user_cases));
    assert.ok(Array.isArray(r.deferred));
    assert.ok(Array.isArray(r.cut));
    assert.ok(Array.isArray(r.scenarios));
    assert.ok(Array.isArray(r.pp_conflict));
    assert.ok(Array.isArray(r.ambiguity_hints));
    assert.equal(r.convergence, false);
  });

  it('emits a classifier_unavailable next_question', () => {
    const r = neutralResult();
    assert.ok(r.next_question);
    assert.equal(r.next_question.kind, 'clarify');
    assert.equal(r.next_question.payload.reason, 'classifier_unavailable');
  });

  it('records at least one ambiguity hint so orchestrator knows to degrade', () => {
    const r = neutralResult();
    assert.ok(r.ambiguity_hints.length >= 1);
  });
});
