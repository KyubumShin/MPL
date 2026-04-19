import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUserContractText,
  computeUncoveredUcs,
} from '../mpl-require-e2e.mjs';

describe('parseUserContractText', () => {
  it('extracts included UC ids with explicit status', () => {
    const text = `
schema_version: 1
user_cases:
  - id: "UC-01"
    status: included
  - id: "UC-02"
    status: included
scenarios: []
`;
    const r = parseUserContractText(text);
    assert.deepEqual(r.included_uc_ids, ['UC-01', 'UC-02']);
  });

  it('defaults UC status to included when unspecified', () => {
    const text = `
user_cases:
  - id: "UC-05"
    title: "x"
  - id: "UC-06"
    title: "y"
`;
    const r = parseUserContractText(text);
    assert.deepEqual(r.included_uc_ids, ['UC-05', 'UC-06']);
  });

  it('excludes deferred and cut UCs', () => {
    const text = `
user_cases:
  - id: "UC-01"
    status: included
  - id: "UC-02"
    status: deferred
  - id: "UC-03"
    status: cut
`;
    const r = parseUserContractText(text);
    assert.deepEqual(r.included_uc_ids, ['UC-01']);
  });

  it('parses scenarios with inline covers and skip_allowed', () => {
    const text = `
scenarios:
  - id: "SC-01"
    covers: [UC-01, UC-02]
    skip_allowed: [ENV_API_DOWN]
  - id: "SC-02"
    covers: ["UC-03"]
    skip_allowed: []
`;
    const r = parseUserContractText(text);
    assert.equal(r.scenarios.length, 2);
    assert.deepEqual(r.scenarios[0].covers, ['UC-01', 'UC-02']);
    assert.deepEqual(r.scenarios[0].skip_allowed, ['ENV_API_DOWN']);
    assert.deepEqual(r.scenarios[1].covers, ['UC-03']);
    assert.deepEqual(r.scenarios[1].skip_allowed, []);
  });

  it('parses scenarios with block covers list', () => {
    const text = `
scenarios:
  - id: "SC-01"
    covers:
      - "UC-01"
      - "UC-02"
    skip_allowed:
      - ENV_API_DOWN
      - FLAKY_NETWORK
`;
    const r = parseUserContractText(text);
    assert.equal(r.scenarios.length, 1);
    assert.deepEqual(r.scenarios[0].covers, ['UC-01', 'UC-02']);
    assert.deepEqual(r.scenarios[0].skip_allowed, ['ENV_API_DOWN', 'FLAKY_NETWORK']);
  });

  it('handles multiple sections together', () => {
    const text = `
schema_version: 1
user_cases:
  - id: "UC-01"
    status: included
  - id: "UC-02"
    status: included
deferred_cases:
  - id: "UC-09"
    reason: "later"
scenarios:
  - id: "SC-01"
    covers: [UC-01]
  - id: "SC-02"
    covers: [UC-02]
`;
    const r = parseUserContractText(text);
    assert.deepEqual(r.included_uc_ids, ['UC-01', 'UC-02']);
    assert.equal(r.scenarios.length, 2);
  });

  it('returns empty for null/empty input', () => {
    assert.deepEqual(parseUserContractText(''), { included_uc_ids: [], scenarios: [] });
    assert.deepEqual(parseUserContractText(null), { included_uc_ids: [], scenarios: [] });
  });
});

describe('computeUncoveredUcs', () => {
  it('returns uncovered UCs when scenarios do not cover all', () => {
    const uncovered = computeUncoveredUcs(
      ['UC-01', 'UC-02', 'UC-03'],
      [{ id: 'SC-1', covers: ['UC-01'] }],
    );
    assert.deepEqual(uncovered, ['UC-02', 'UC-03']);
  });

  it('returns empty when all UCs are covered', () => {
    const uncovered = computeUncoveredUcs(
      ['UC-01', 'UC-02'],
      [
        { id: 'SC-1', covers: ['UC-01'] },
        { id: 'SC-2', covers: ['UC-02'] },
      ],
    );
    assert.deepEqual(uncovered, []);
  });

  it('counts cross-scenario coverage (union)', () => {
    const uncovered = computeUncoveredUcs(
      ['UC-01', 'UC-02'],
      [{ id: 'SC-1', covers: ['UC-01', 'UC-02'] }],
    );
    assert.deepEqual(uncovered, []);
  });

  it('handles scenarios with missing covers field', () => {
    const uncovered = computeUncoveredUcs(
      ['UC-01'],
      [{ id: 'SC-1' }], // no covers field
    );
    assert.deepEqual(uncovered, ['UC-01']);
  });

  it('returns empty when no included UCs', () => {
    const uncovered = computeUncoveredUcs([], [{ id: 'SC-1', covers: ['UC-01'] }]);
    assert.deepEqual(uncovered, []);
  });
});
