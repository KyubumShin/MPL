import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetsDecompositionFile,
  parsePhaseCovers,
  validatePhase,
  computeInternalRatio,
} from '../mpl-require-covers.mjs';

describe('targetsDecompositionFile', () => {
  it('matches .mpl/mpl/decomposition.yaml', () => {
    assert.equal(
      targetsDecompositionFile('/repo/.mpl/mpl/decomposition.yaml'),
      true,
    );
  });
  it('does not match unrelated files', () => {
    assert.equal(
      targetsDecompositionFile('/repo/.mpl/mpl/chain-assignment.yaml'),
      false,
    );
    assert.equal(
      targetsDecompositionFile('/repo/.mpl/requirements/user-contract.md'),
      false,
    );
  });
  it('returns false for null/empty', () => {
    assert.equal(targetsDecompositionFile(null), false);
    assert.equal(targetsDecompositionFile(''), false);
  });
});

describe('parsePhaseCovers', () => {
  it('parses inline array form', () => {
    const yaml = `
phases:
  - id: "phase-1"
    covers: [UC-01, UC-02]
  - id: "phase-2"
    covers: ["internal"]
`;
    const out = parsePhaseCovers(yaml);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].covers, ['UC-01', 'UC-02']);
    assert.deepEqual(out[1].covers, ['internal']);
  });

  it('parses block list form', () => {
    const yaml = `
phases:
  - id: "phase-1"
    name: "x"
    covers:
      - "UC-01"
      - "UC-05"
    impact:
      create: []
  - id: "phase-2"
    covers:
      - internal
`;
    const out = parsePhaseCovers(yaml);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].covers, ['UC-01', 'UC-05']);
    assert.deepEqual(out[1].covers, ['internal']);
  });

  it('records null covers when field missing', () => {
    const yaml = `
phases:
  - id: "phase-1"
    name: "no covers"
    impact:
      create: []
`;
    const out = parsePhaseCovers(yaml);
    assert.equal(out.length, 1);
    assert.equal(out[0].covers, null);
  });

  it('records empty array when covers is []', () => {
    const yaml = `
phases:
  - id: "phase-1"
    covers: []
`;
    const out = parsePhaseCovers(yaml);
    assert.deepEqual(out[0].covers, []);
  });

  it('handles null/empty input', () => {
    assert.deepEqual(parsePhaseCovers(null), []);
    assert.deepEqual(parsePhaseCovers(''), []);
  });
});

describe('validatePhase', () => {
  it('flags missing covers', () => {
    const issues = validatePhase({ id: 'phase-1', covers: null }, { allowLegacy: false });
    assert.ok(issues.some((i) => i.kind === 'missing'));
  });
  it('flags empty covers', () => {
    const issues = validatePhase({ id: 'phase-1', covers: [] }, { allowLegacy: false });
    assert.ok(issues.some((i) => i.kind === 'empty'));
  });
  it('accepts valid UC-NN', () => {
    const issues = validatePhase({ id: 'p', covers: ['UC-01', 'UC-15'] }, { allowLegacy: false });
    assert.equal(issues.length, 0);
  });
  it('accepts internal escape', () => {
    const issues = validatePhase({ id: 'p', covers: ['internal'] }, { allowLegacy: false });
    assert.equal(issues.length, 0);
  });
  it('rejects invalid entry', () => {
    const issues = validatePhase({ id: 'p', covers: ['bogus'] }, { allowLegacy: false });
    assert.ok(issues.some((i) => i.kind === 'invalid_entry' && i.entry === 'bogus'));
  });
  it('rejects single-digit UC (requires UC-NN 2+ digits)', () => {
    const issues = validatePhase({ id: 'p', covers: ['UC-1'] }, { allowLegacy: false });
    assert.ok(issues.some((i) => i.kind === 'invalid_entry'));
  });
  it('legacy mode downgrades invalid entries but still blocks missing/empty', () => {
    const legacyOk = validatePhase({ id: 'p', covers: ['bogus'] }, { allowLegacy: true });
    assert.equal(legacyOk.length, 0);
    const legacyMissing = validatePhase({ id: 'p', covers: null }, { allowLegacy: true });
    assert.ok(legacyMissing.some((i) => i.kind === 'missing'));
  });
});

describe('computeInternalRatio', () => {
  it('returns 0 for all-UC phases', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['UC-01'] },
      { id: 'b', covers: ['UC-02'] },
    ]);
    assert.equal(r, 0);
  });
  it('returns 1 for all-internal phases', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['internal'] },
      { id: 'b', covers: ['internal'] },
    ]);
    assert.equal(r, 1);
  });
  it('returns mixed ratio', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['UC-01'] },
      { id: 'b', covers: ['internal'] },
      { id: 'c', covers: ['internal'] },
      { id: 'd', covers: ['UC-02'] },
    ]);
    assert.equal(r, 0.5);
  });
  it('phase with UC + internal mix counts as NOT internal-only', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['UC-01', 'internal'] },
      { id: 'b', covers: ['internal'] },
    ]);
    assert.equal(r, 0.5);
  });
  it('ignores phases with null/empty covers', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['UC-01'] },
      { id: 'b', covers: null },
      { id: 'c', covers: [] },
    ]);
    assert.equal(r, 0);
  });
  it('returns 0 when no valid phases', () => {
    assert.equal(computeInternalRatio([]), 0);
    assert.equal(computeInternalRatio([{ id: 'a', covers: null }]), 0);
  });
});
