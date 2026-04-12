import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePivotPoints, matchFileToPP } from '../mpl-sentinel-pp-file.mjs';

describe('parsePivotPoints', () => {
  it('should extract PP entries with file references', () => {
    const content = `# Pivot Points

## PP-1: Auth tokens must use secure storage
All token handling in \`src/auth/token.ts\` and \`src/auth/session.ts\` must use SecureStore.

## PP-2: Database migrations are append-only
Files in \`migrations/*.sql\` must never modify existing migration files.

## PP-3: No file references here
This PP has no inline file references.
`;
    const result = parsePivotPoints(content);
    assert.equal(result.length, 2);
    assert.equal(result[0].pp_id, 'PP-1');
    assert.ok(result[0].patterns.includes('src/auth/token.ts'));
    assert.ok(result[0].patterns.includes('src/auth/session.ts'));
    assert.equal(result[1].pp_id, 'PP-2');
    assert.ok(result[1].patterns.some(p => p.includes('migrations/')));
  });

  it('should return empty for content without PPs', () => {
    assert.deepEqual(parsePivotPoints('# No PPs here'), []);
    assert.deepEqual(parsePivotPoints(''), []);
    assert.deepEqual(parsePivotPoints(null), []);
  });
});

describe('matchFileToPP', () => {
  const ppEntries = [
    { pp_id: 'PP-1', constraint: 'Secure storage', patterns: ['src/auth/token.ts', 'src/auth/session.ts'] },
    { pp_id: 'PP-2', constraint: 'Append-only migrations', patterns: ['migrations/*.sql'] },
  ];

  it('should match exact file path', () => {
    const matches = matchFileToPP('/project/src/auth/token.ts', ppEntries);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].pp_id, 'PP-1');
  });

  it('should match glob pattern', () => {
    const matches = matchFileToPP('migrations/003_add_users.sql', ppEntries);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].pp_id, 'PP-2');
  });

  it('should return empty for non-matching file', () => {
    const matches = matchFileToPP('src/utils/format.ts', ppEntries);
    assert.equal(matches.length, 0);
  });

  it('should handle multiple PP matches', () => {
    const entries = [
      { pp_id: 'PP-1', constraint: 'A', patterns: ['src/shared.ts'] },
      { pp_id: 'PP-2', constraint: 'B', patterns: ['src/shared.ts'] },
    ];
    const matches = matchFileToPP('src/shared.ts', entries);
    assert.equal(matches.length, 2);
  });
});
