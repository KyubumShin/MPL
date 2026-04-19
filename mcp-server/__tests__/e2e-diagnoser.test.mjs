import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_VERSION,
  parseDiagnosis,
  neutralDiagnosis,
} from '../dist/lib/e2e-diagnoser.js';

describe('PROMPT_VERSION', () => {
  it('is a frozen version string', () => {
    assert.equal(typeof PROMPT_VERSION, 'string');
    assert.ok(PROMPT_VERSION.length > 0);
  });
});

describe('parseDiagnosis', () => {
  const validA = {
    classification: 'A',
    root_cause: 'No /reset-password route exists in src/auth/router.ts',
    fix_strategy: 'Append phase to add POST /reset-password handler; see append_phases.',
    iter_hint: 1,
    trace_excerpt: '404 Not Found at POST /reset-password (line 47 of reset.spec.ts)',
    append_phases: [
      {
        position: 'after',
        anchor_phase: 'phase-3',
        proposed_id: 'phase-3b',
        goal: 'Add reset-password endpoint',
        covers: ['UC-05'],
      },
    ],
    confidence: 0.9,
  };

  it('parses a valid A diagnosis', () => {
    const r = parseDiagnosis(JSON.stringify(validA));
    assert.ok(r);
    assert.equal(r.classification, 'A');
    assert.equal(r.iter_hint, 1);
    assert.equal(r.append_phases.length, 1);
    assert.equal(r.prompt_version, PROMPT_VERSION);
  });

  it('parses JSON embedded in surrounding text', () => {
    const r = parseDiagnosis(`Preamble...\n${JSON.stringify(validA)}\nEnd.`);
    assert.ok(r);
    assert.equal(r.classification, 'A');
  });

  it('rejects invalid classification values', () => {
    const bad = { ...validA, classification: 'Z' };
    assert.equal(parseDiagnosis(JSON.stringify(bad)), null);
  });

  it('rejects missing required fields', () => {
    const noRoot = { ...validA };
    delete noRoot.root_cause;
    assert.equal(parseDiagnosis(JSON.stringify(noRoot)), null);

    const noAppend = { ...validA };
    delete noAppend.append_phases;
    assert.equal(parseDiagnosis(JSON.stringify(noAppend)), null);
  });

  it('clamps iter_hint to 0..2', () => {
    const high = { ...validA, iter_hint: 99 };
    const rh = parseDiagnosis(JSON.stringify(high));
    assert.equal(rh.iter_hint, 2);
    const low = { ...validA, iter_hint: -5 };
    const rl = parseDiagnosis(JSON.stringify(low));
    assert.equal(rl.iter_hint, 0);
  });

  it('clamps confidence to 0..1', () => {
    const over = { ...validA, confidence: 2.5 };
    assert.equal(parseDiagnosis(JSON.stringify(over)).confidence, 1);
    const under = { ...validA, confidence: -0.5 };
    assert.equal(parseDiagnosis(JSON.stringify(under)).confidence, 0);
  });

  it('truncates trace_excerpt to 400 chars', () => {
    const long = { ...validA, trace_excerpt: 'x'.repeat(1000) };
    const r = parseDiagnosis(JSON.stringify(long));
    assert.equal(r.trace_excerpt.length, 400);
  });

  it('accepts all four classifications A/B/C/D', () => {
    for (const k of ['A', 'B', 'C', 'D']) {
      const payload = { ...validA, classification: k, append_phases: [] };
      const r = parseDiagnosis(JSON.stringify(payload));
      assert.ok(r);
      assert.equal(r.classification, k);
    }
  });

  it('returns null for malformed JSON', () => {
    assert.equal(parseDiagnosis('{unclosed'), null);
    assert.equal(parseDiagnosis(''), null);
  });
});

describe('neutralDiagnosis', () => {
  it('defaults to D (flake) to avoid false phase appends', () => {
    const r = neutralDiagnosis();
    assert.equal(r.classification, 'D');
    assert.equal(r.append_phases.length, 0);
    assert.equal(r.confidence, 0);
  });

  it('sets iter_hint to 1 (count against budget)', () => {
    const r = neutralDiagnosis();
    assert.equal(r.iter_hint, 1);
  });

  it('carries the frozen PROMPT_VERSION', () => {
    assert.equal(neutralDiagnosis().prompt_version, PROMPT_VERSION);
  });
});
