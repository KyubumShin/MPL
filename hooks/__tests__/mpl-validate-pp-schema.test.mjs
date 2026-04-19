import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetsPivotPointsFile,
  extractProposedContent,
  detectUcLeakage,
  formatBlockReason,
} from '../mpl-validate-pp-schema.mjs';

describe('targetsPivotPointsFile', () => {
  it('matches .mpl/pivot-points.md at repo root', () => {
    assert.equal(targetsPivotPointsFile('/repo/.mpl/pivot-points.md'), true);
  });

  it('matches nested .mpl/pivot-points.md', () => {
    assert.equal(targetsPivotPointsFile('/work/project/.mpl/pivot-points.md'), true);
  });

  it('matches relative path', () => {
    assert.equal(targetsPivotPointsFile('.mpl/pivot-points.md'), true);
  });

  it('does not match user-contract.md', () => {
    assert.equal(targetsPivotPointsFile('/repo/.mpl/requirements/user-contract.md'), false);
  });

  it('does not match other pivot-points references', () => {
    assert.equal(targetsPivotPointsFile('/repo/docs/pivot-points.md'), false);
    assert.equal(targetsPivotPointsFile('/repo/.mpl/pivot-points-backup.md'), false);
  });

  it('returns false for null/undefined/empty', () => {
    assert.equal(targetsPivotPointsFile(null), false);
    assert.equal(targetsPivotPointsFile(undefined), false);
    assert.equal(targetsPivotPointsFile(''), false);
  });
});

describe('extractProposedContent', () => {
  it('returns content for Write', () => {
    assert.equal(extractProposedContent({ content: 'body' }, 'Write'), 'body');
  });

  it('returns new_string for Edit', () => {
    assert.equal(extractProposedContent({ new_string: 'new body' }, 'Edit'), 'new body');
  });

  it('returns empty for unknown tool', () => {
    assert.equal(extractProposedContent({ content: 'x' }, 'Bash'), '');
  });

  it('handles missing fields', () => {
    assert.equal(extractProposedContent({}, 'Write'), '');
    assert.equal(extractProposedContent({}, 'Edit'), '');
    assert.equal(extractProposedContent(null, 'Write'), '');
  });
});

describe('detectUcLeakage', () => {
  it('detects user_cases: YAML key', () => {
    const hits = detectUcLeakage('user_cases:\n  - id: UC-01');
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((h) => h.name === 'user_cases:'));
  });

  it('detects deferred_cases: YAML key', () => {
    const hits = detectUcLeakage('deferred_cases:\n  - id: X');
    assert.ok(hits.some((h) => h.name === 'deferred_cases:'));
  });

  it('detects cut_cases: YAML key', () => {
    const hits = detectUcLeakage('cut_cases:\n  - id: X');
    assert.ok(hits.some((h) => h.name === 'cut_cases:'));
  });

  it('detects nested user_delta: field', () => {
    const hits = detectUcLeakage('  user_delta: "added by user"');
    assert.ok(hits.some((h) => h.name === 'user_delta:'));
  });

  it('detects covers_pp: field', () => {
    const hits = detectUcLeakage('  covers_pp: [PP-1]');
    assert.ok(hits.some((h) => h.name === 'covers_pp:'));
  });

  it('detects UC-NN identifiers', () => {
    const hits = detectUcLeakage('This phase covers UC-01 and UC-15.');
    assert.ok(hits.some((h) => h.name === 'UC-NN identifier'));
  });

  it('does NOT flag plain PP content', () => {
    const clean = `# Pivot Points

## PP-1: Auth tokens must use secure storage
All token handling in \`src/auth/token.ts\` must use SecureStore.

## PP-2: Append-only migrations
Files in \`migrations/*.sql\` never modify existing entries.
`;
    assert.deepEqual(detectUcLeakage(clean), []);
  });

  it('does NOT flag single-digit UC-like strings (PP-1 style)', () => {
    // PP-1 is fine, UC-1 is also intentionally NOT matched (require 2+ digits)
    const hits = detectUcLeakage('See UC-1 in legacy doc.');
    assert.deepEqual(hits, []);
  });

  it('returns empty for empty or null input', () => {
    assert.deepEqual(detectUcLeakage(''), []);
    assert.deepEqual(detectUcLeakage(null), []);
    assert.deepEqual(detectUcLeakage(undefined), []);
  });
});

describe('formatBlockReason', () => {
  it('includes detected marker names', () => {
    const reason = formatBlockReason([
      { name: 'user_cases:' },
      { name: 'UC-NN identifier' },
    ]);
    assert.ok(reason.includes('user_cases:'));
    assert.ok(reason.includes('UC-NN identifier'));
  });

  it('points to user-contract.md as correct location', () => {
    const reason = formatBlockReason([{ name: 'user_cases:' }]);
    assert.ok(reason.includes('user-contract.md'));
  });
});
