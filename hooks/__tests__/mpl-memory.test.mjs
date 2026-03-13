import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ensureMemoryDir,
  readEpisodicMemory,
  appendEpisodic,
  compressEpisodic,
  readSemanticMemory,
  promoteToSemantic,
  detectRepeatedPatterns,
  readProcedural,
  appendProcedural,
  queryProcedural,
  readWorkingMemory,
  updateWorkingMemory,
  clearWorkingMemory,
  loadRelevantMemory,
  getMemoryStats,
} from '../lib/mpl-memory.mjs';

const MEMORY_DIR = '.mpl/memory';

// ──────────────────────────────────────
// ensureMemoryDir
// ──────────────────────────────────────

describe('ensureMemoryDir', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('creates .mpl/memory/ directory when it does not exist', async () => {
    const cwd = join(tempDir, 'ensure-1');
    await mkdir(cwd, { recursive: true });
    await ensureMemoryDir(cwd);
    const { stat } = await import('node:fs/promises');
    const s = await stat(join(cwd, MEMORY_DIR));
    assert.ok(s.isDirectory());
  });

  it('does not throw when directory already exists', async () => {
    const cwd = join(tempDir, 'ensure-2');
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    await assert.doesNotReject(() => ensureMemoryDir(cwd));
  });
});

// ──────────────────────────────────────
// readEpisodicMemory
// ──────────────────────────────────────

describe('readEpisodicMemory', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('returns empty array when episodic.md does not exist', async () => {
    const cwd = join(tempDir, 'epis-missing');
    await mkdir(cwd, { recursive: true });
    const result = await readEpisodicMemory(cwd);
    assert.deepEqual(result, []);
  });

  it('returns empty array when episodic.md is empty', async () => {
    const cwd = join(tempDir, 'epis-empty');
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    await writeFile(join(cwd, MEMORY_DIR, 'episodic.md'), '', 'utf-8');
    const result = await readEpisodicMemory(cwd);
    assert.deepEqual(result, []);
  });

  it('parses a single episodic section correctly', async () => {
    const cwd = join(tempDir, 'epis-single');
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    const content = '### Phase 1: Fix auth bug (2026-01-01T00:00:00.000Z)\nFixed the token validation.\n\n';
    await writeFile(join(cwd, MEMORY_DIR, 'episodic.md'), content, 'utf-8');
    const result = await readEpisodicMemory(cwd);
    assert.equal(result.length, 1);
    assert.equal(result[0].phase, '1');
    assert.equal(result[0].name, 'Fix auth bug');
    assert.equal(result[0].timestamp, '2026-01-01T00:00:00.000Z');
    assert.ok(result[0].body.includes('Fixed the token validation.'));
  });

  it('parses multiple episodic sections and preserves order', async () => {
    const cwd = join(tempDir, 'epis-multi');
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    const content = [
      '### Phase 1: Phase one (2026-01-01T00:00:00.000Z)',
      'Body one.',
      '',
      '### Phase 2: Phase two (2026-01-02T00:00:00.000Z)',
      'Body two.',
      '',
    ].join('\n');
    await writeFile(join(cwd, MEMORY_DIR, 'episodic.md'), content, 'utf-8');
    const result = await readEpisodicMemory(cwd);
    assert.equal(result.length, 2);
    assert.equal(result[0].phase, '1');
    assert.equal(result[1].phase, '2');
  });
});

// ──────────────────────────────────────
// appendEpisodic
// ──────────────────────────────────────

describe('appendEpisodic', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('creates episodic.md with first entry when file does not exist', async () => {
    const cwd = join(tempDir, 'append-epis-1');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '1', 'Setup complete\nAll deps installed.');
    const result = await readEpisodicMemory(cwd);
    assert.equal(result.length, 1);
    assert.equal(result[0].phase, '1');
    assert.equal(result[0].name, 'Setup complete');
  });

  it('appends a second entry without overwriting the first', async () => {
    const cwd = join(tempDir, 'append-epis-2');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '1', 'First phase\nDone.');
    await appendEpisodic(cwd, '2', 'Second phase\nAlso done.');
    const result = await readEpisodicMemory(cwd);
    assert.equal(result.length, 2);
    assert.equal(result[0].phase, '1');
    assert.equal(result[1].phase, '2');
  });

  it('uses the first line of summary as the section name', async () => {
    const cwd = join(tempDir, 'append-epis-name');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '3', 'Name from first line\nExtra body detail.');
    const result = await readEpisodicMemory(cwd);
    assert.equal(result[0].name, 'Name from first line');
  });
});

// ──────────────────────────────────────
// compressEpisodic
// ──────────────────────────────────────

describe('compressEpisodic', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('does not modify file when entry count is at or below keepDetailedCount', async () => {
    const cwd = join(tempDir, 'compress-noop');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '1', 'Phase one\nBody.');
    await appendEpisodic(cwd, '2', 'Phase two\nBody.');
    await compressEpisodic(cwd, 2);
    const result = await readEpisodicMemory(cwd);
    // 2 sections, keepDetailedCount=2: no compression, both remain as detailed sections
    assert.equal(result.length, 2);
  });

  it('compresses older entries to single bullet lines', async () => {
    const cwd = join(tempDir, 'compress-old');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '1', 'Old phase\nOld detailed body text here.');
    await appendEpisodic(cwd, '2', 'Middle phase\nMiddle body.');
    await appendEpisodic(cwd, '3', 'Recent phase\nRecent body.');
    await compressEpisodic(cwd, 2);

    const raw = await readFile(join(cwd, MEMORY_DIR, 'episodic.md'), 'utf-8');
    // The oldest entry should now be a bullet, not a ### header
    assert.ok(raw.includes('- Phase 1:'));
    assert.ok(!raw.includes('### Phase 1:'));
  });

  it('keeps the most recent N entries as detailed sections', async () => {
    const cwd = join(tempDir, 'compress-keep');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '1', 'Old phase\nOld body.');
    await appendEpisodic(cwd, '2', 'Recent A\nBody A.');
    await appendEpisodic(cwd, '3', 'Recent B\nBody B.');
    await compressEpisodic(cwd, 2);

    const raw = await readFile(join(cwd, MEMORY_DIR, 'episodic.md'), 'utf-8');
    assert.ok(raw.includes('### Phase 2:'));
    assert.ok(raw.includes('### Phase 3:'));
  });
});

// ──────────────────────────────────────
// readSemanticMemory
// ──────────────────────────────────────

describe('readSemanticMemory', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('returns empty string when semantic.md does not exist', async () => {
    const cwd = join(tempDir, 'sem-missing');
    await mkdir(cwd, { recursive: true });
    const result = await readSemanticMemory(cwd);
    assert.equal(result, '');
  });

  it('returns file content when semantic.md exists', async () => {
    const cwd = join(tempDir, 'sem-exists');
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    await writeFile(join(cwd, MEMORY_DIR, 'semantic.md'), '## Failure Patterns\n- Always validate input.\n', 'utf-8');
    const result = await readSemanticMemory(cwd);
    assert.ok(result.includes('Always validate input.'));
  });
});

// ──────────────────────────────────────
// promoteToSemantic
// ──────────────────────────────────────

describe('promoteToSemantic', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('creates semantic.md with new category when file does not exist', async () => {
    const cwd = join(tempDir, 'promote-new');
    await mkdir(cwd, { recursive: true });
    await promoteToSemantic(cwd, 'Always check null before access', 'Failure Patterns');
    const content = await readSemanticMemory(cwd);
    assert.ok(content.includes('## Failure Patterns'));
    assert.ok(content.includes('- Always check null before access'));
  });

  it('appends to an existing category header', async () => {
    const cwd = join(tempDir, 'promote-append');
    await mkdir(cwd, { recursive: true });
    await promoteToSemantic(cwd, 'Rule one', 'Success Patterns');
    await promoteToSemantic(cwd, 'Rule two', 'Success Patterns');
    const content = await readSemanticMemory(cwd);
    assert.ok(content.includes('- Rule one'));
    assert.ok(content.includes('- Rule two'));
    // only one header section
    const headerCount = (content.match(/## Success Patterns/g) || []).length;
    assert.equal(headerCount, 1);
  });

  it('creates a new category section when category does not exist yet', async () => {
    const cwd = join(tempDir, 'promote-newcat');
    await mkdir(cwd, { recursive: true });
    await promoteToSemantic(cwd, 'Use strict types', 'Project Conventions');
    await promoteToSemantic(cwd, 'Avoid raw errors', 'Failure Patterns');
    const content = await readSemanticMemory(cwd);
    assert.ok(content.includes('## Project Conventions'));
    assert.ok(content.includes('## Failure Patterns'));
  });
});

// ──────────────────────────────────────
// detectRepeatedPatterns
// ──────────────────────────────────────

describe('detectRepeatedPatterns', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('returns empty array when episodic has fewer entries than threshold', async () => {
    const cwd = join(tempDir, 'detect-few');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '1', 'Short phase\nBody.');
    await appendEpisodic(cwd, '2', 'Short phase\nBody.');
    const result = await detectRepeatedPatterns(cwd, 3);
    assert.deepEqual(result, []);
  });

  it('detects keywords appearing threshold or more times across sections', async () => {
    const cwd = join(tempDir, 'detect-repeat');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '1', 'auth validation\nauth token checked.');
    await appendEpisodic(cwd, '2', 'auth check again\nauth still required.');
    await appendEpisodic(cwd, '3', 'auth refresh\nauth token expired.');
    const result = await detectRepeatedPatterns(cwd, 3);
    const keywords = result.map(r => r.keyword);
    assert.ok(keywords.includes('auth'));
  });

  it('returns results sorted by count descending', async () => {
    const cwd = join(tempDir, 'detect-sort');
    await mkdir(cwd, { recursive: true });
    for (let i = 1; i <= 4; i++) {
      await appendEpisodic(cwd, String(i), `error failure\nerror occurred again.`);
    }
    const result = await detectRepeatedPatterns(cwd, 3);
    assert.ok(result.length > 0);
    for (let i = 0; i < result.length - 1; i++) {
      assert.ok(result[i].count >= result[i + 1].count);
    }
  });

  it('each result entry has keyword, count, and category fields', async () => {
    const cwd = join(tempDir, 'detect-fields');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '1', 'build failure\nbuild failed again.');
    await appendEpisodic(cwd, '2', 'build failure\nbuild failed again.');
    await appendEpisodic(cwd, '3', 'build failure\nbuild failed again.');
    const result = await detectRepeatedPatterns(cwd, 3);
    if (result.length > 0) {
      const entry = result[0];
      assert.ok('keyword' in entry);
      assert.ok('count' in entry);
      assert.ok('category' in entry);
    }
  });
});

// ──────────────────────────────────────
// readProcedural
// ──────────────────────────────────────

describe('readProcedural', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('returns empty array when procedural.jsonl does not exist', async () => {
    const cwd = join(tempDir, 'proc-missing');
    await mkdir(cwd, { recursive: true });
    const result = await readProcedural(cwd);
    assert.deepEqual(result, []);
  });

  it('returns empty array when procedural.jsonl is empty', async () => {
    const cwd = join(tempDir, 'proc-empty');
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    await writeFile(join(cwd, MEMORY_DIR, 'procedural.jsonl'), '', 'utf-8');
    const result = await readProcedural(cwd);
    assert.deepEqual(result, []);
  });

  it('parses valid JSONL entries into objects', async () => {
    const cwd = join(tempDir, 'proc-parse');
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    const lines = [
      JSON.stringify({ tool: 'bash', tags: ['build'], result: 'ok' }),
      JSON.stringify({ tool: 'edit', tags: ['refactor'], result: 'ok' }),
    ].join('\n') + '\n';
    await writeFile(join(cwd, MEMORY_DIR, 'procedural.jsonl'), lines, 'utf-8');
    const result = await readProcedural(cwd);
    assert.equal(result.length, 2);
    assert.equal(result[0].tool, 'bash');
    assert.equal(result[1].tool, 'edit');
  });

  it('skips invalid JSON lines without throwing', async () => {
    const cwd = join(tempDir, 'proc-invalid');
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    const lines = [
      JSON.stringify({ tool: 'valid' }),
      'not valid json {{{',
      JSON.stringify({ tool: 'also-valid' }),
    ].join('\n') + '\n';
    await writeFile(join(cwd, MEMORY_DIR, 'procedural.jsonl'), lines, 'utf-8');
    const result = await readProcedural(cwd);
    assert.equal(result.length, 2);
  });
});

// ──────────────────────────────────────
// appendProcedural
// ──────────────────────────────────────

describe('appendProcedural', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('creates procedural.jsonl with first entry', async () => {
    const cwd = join(tempDir, 'appproc-1');
    await mkdir(cwd, { recursive: true });
    await appendProcedural(cwd, { tool: 'bash', action: 'run tests', result: 'pass', tags: ['test'] });
    const entries = await readProcedural(cwd);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool, 'bash');
    assert.equal(entries[0].action, 'run tests');
    assert.deepEqual(entries[0].tags, ['test']);
  });

  it('appends entries without overwriting existing ones', async () => {
    const cwd = join(tempDir, 'appproc-2');
    await mkdir(cwd, { recursive: true });
    await appendProcedural(cwd, { tool: 'bash', tags: ['a'] });
    await appendProcedural(cwd, { tool: 'edit', tags: ['b'] });
    const entries = await readProcedural(cwd);
    assert.equal(entries.length, 2);
  });

  it('enforces FIFO cap of 100 entries', async () => {
    const cwd = join(tempDir, 'appproc-fifo');
    await mkdir(cwd, { recursive: true });
    for (let i = 0; i < 105; i++) {
      await appendProcedural(cwd, { tool: `tool-${i}`, tags: [] });
    }
    const entries = await readProcedural(cwd);
    assert.equal(entries.length, 100);
    // oldest entries should be dropped; most recent should remain
    assert.equal(entries[entries.length - 1].tool, 'tool-104');
  });

  it('fills in default null values for missing fields', async () => {
    const cwd = join(tempDir, 'appproc-defaults');
    await mkdir(cwd, { recursive: true });
    await appendProcedural(cwd, {});
    const entries = await readProcedural(cwd);
    assert.equal(entries[0].tool, null);
    assert.equal(entries[0].phase, null);
    assert.deepEqual(entries[0].tags, []);
  });
});

// ──────────────────────────────────────
// queryProcedural
// ──────────────────────────────────────

describe('queryProcedural', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('returns empty array when no entries exist', async () => {
    const cwd = join(tempDir, 'query-empty');
    await mkdir(cwd, { recursive: true });
    const result = await queryProcedural(cwd, ['test']);
    assert.deepEqual(result, []);
  });

  it('returns last N entries when tags array is empty', async () => {
    const cwd = join(tempDir, 'query-notags');
    await mkdir(cwd, { recursive: true });
    for (let i = 0; i < 5; i++) {
      await appendProcedural(cwd, { tool: `tool-${i}`, tags: [] });
    }
    const result = await queryProcedural(cwd, []);
    assert.equal(result.length, 5);
  });

  it('filters entries by matching tags', async () => {
    const cwd = join(tempDir, 'query-filter');
    await mkdir(cwd, { recursive: true });
    await appendProcedural(cwd, { tool: 'bash', tags: ['build', 'test'] });
    await appendProcedural(cwd, { tool: 'edit', tags: ['refactor'] });
    await appendProcedural(cwd, { tool: 'read', tags: ['test', 'debug'] });
    const result = await queryProcedural(cwd, ['test']);
    assert.equal(result.length, 2);
    const tools = result.map(e => e.tool);
    assert.ok(tools.includes('bash'));
    assert.ok(tools.includes('read'));
    assert.ok(!tools.includes('edit'));
  });

  it('sorts results by number of matching tags descending', async () => {
    const cwd = join(tempDir, 'query-score');
    await mkdir(cwd, { recursive: true });
    await appendProcedural(cwd, { tool: 'one-match', tags: ['test'] });
    await appendProcedural(cwd, { tool: 'two-matches', tags: ['test', 'build'] });
    const result = await queryProcedural(cwd, ['test', 'build']);
    assert.equal(result[0].tool, 'two-matches');
  });
});

// ──────────────────────────────────────
// readWorkingMemory
// ──────────────────────────────────────

describe('readWorkingMemory', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('returns empty string when working.md does not exist', async () => {
    const cwd = join(tempDir, 'work-missing');
    await mkdir(cwd, { recursive: true });
    const result = await readWorkingMemory(cwd);
    assert.equal(result, '');
  });

  it('returns current content of working.md', async () => {
    const cwd = join(tempDir, 'work-read');
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    await writeFile(join(cwd, MEMORY_DIR, 'working.md'), '# TODO\n- [ ] task one', 'utf-8');
    const result = await readWorkingMemory(cwd);
    assert.ok(result.includes('task one'));
  });
});

// ──────────────────────────────────────
// updateWorkingMemory
// ──────────────────────────────────────

describe('updateWorkingMemory', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('creates working.md with provided content', async () => {
    const cwd = join(tempDir, 'work-create');
    await mkdir(cwd, { recursive: true });
    await updateWorkingMemory(cwd, '# Phase 1 TODO\n- [x] step 1');
    const result = await readWorkingMemory(cwd);
    assert.ok(result.includes('Phase 1 TODO'));
  });

  it('overwrites previous content on subsequent calls', async () => {
    const cwd = join(tempDir, 'work-overwrite');
    await mkdir(cwd, { recursive: true });
    await updateWorkingMemory(cwd, 'old content');
    await updateWorkingMemory(cwd, 'new content');
    const result = await readWorkingMemory(cwd);
    assert.equal(result, 'new content');
  });
});

// ──────────────────────────────────────
// clearWorkingMemory
// ──────────────────────────────────────

describe('clearWorkingMemory', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('sets working.md to empty string', async () => {
    const cwd = join(tempDir, 'work-clear');
    await mkdir(cwd, { recursive: true });
    await updateWorkingMemory(cwd, '# Active tasks\n- task a\n- task b');
    await clearWorkingMemory(cwd);
    const result = await readWorkingMemory(cwd);
    assert.equal(result, '');
  });

  it('does not throw when working.md does not exist yet', async () => {
    const cwd = join(tempDir, 'work-clear-noexist');
    await mkdir(cwd, { recursive: true });
    await assert.doesNotReject(() => clearWorkingMemory(cwd));
  });
});

// ──────────────────────────────────────
// loadRelevantMemory
// ──────────────────────────────────────

describe('loadRelevantMemory', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('returns empty tiers when memory directory has no files', async () => {
    const cwd = join(tempDir, 'load-empty');
    await mkdir(cwd, { recursive: true });
    const result = await loadRelevantMemory(cwd, 'some task', 2000);
    assert.equal(result.semantic, '');
    assert.deepEqual(result.procedural, []);
    assert.equal(result.episodic, '');
    assert.equal(result.totalChars, 0);
  });

  it('returns object with semantic, procedural, episodic, and totalChars keys', async () => {
    const cwd = join(tempDir, 'load-shape');
    await mkdir(cwd, { recursive: true });
    const result = await loadRelevantMemory(cwd, 'build task');
    assert.ok('semantic' in result);
    assert.ok('procedural' in result);
    assert.ok('episodic' in result);
    assert.ok('totalChars' in result);
  });

  it('totalChars reflects the combined character count of all loaded content', async () => {
    const cwd = join(tempDir, 'load-chars');
    await mkdir(cwd, { recursive: true });
    await promoteToSemantic(cwd, 'Use strict null checks', 'Project Conventions');
    await appendEpisodic(cwd, '1', 'Phase done\nDetails here.');
    const result = await loadRelevantMemory(cwd, 'task', 2000);
    const expected = result.semantic.length + result.episodic.length;
    assert.equal(result.totalChars, expected);
  });

  it('respects maxTokens budget by truncating semantic content when it exceeds 40% of budget', async () => {
    const cwd = join(tempDir, 'load-budget');
    await mkdir(cwd, { recursive: true });
    // Write a large semantic file (> 40% of a small token budget)
    const largeContent = 'x'.repeat(2000);
    await mkdir(join(cwd, MEMORY_DIR), { recursive: true });
    await writeFile(join(cwd, MEMORY_DIR, 'semantic.md'), largeContent, 'utf-8');
    // maxTokens=100 => charBudget=400, 40% = 160 chars max for semantic
    const result = await loadRelevantMemory(cwd, 'task', 100);
    assert.ok(result.semantic.length <= 160);
  });
});

// ──────────────────────────────────────
// getMemoryStats
// ──────────────────────────────────────

describe('getMemoryStats', () => {
  let tempDir;
  before(async () => { tempDir = await mkdtemp(join(tmpdir(), 'mpl-memory-test-')); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('returns all-zero stats when memory directory is empty', async () => {
    const cwd = join(tempDir, 'stats-empty');
    await mkdir(cwd, { recursive: true });
    const stats = await getMemoryStats(cwd);
    assert.equal(stats.episodic_entries, 0);
    assert.equal(stats.semantic_rules, 0);
    assert.equal(stats.procedural_entries, 0);
    assert.equal(stats.working_active, false);
  });

  it('counts episodic entries correctly', async () => {
    const cwd = join(tempDir, 'stats-epis');
    await mkdir(cwd, { recursive: true });
    await appendEpisodic(cwd, '1', 'Phase 1\nDone.');
    await appendEpisodic(cwd, '2', 'Phase 2\nDone.');
    const stats = await getMemoryStats(cwd);
    assert.equal(stats.episodic_entries, 2);
  });

  it('counts semantic bullet rules correctly', async () => {
    const cwd = join(tempDir, 'stats-sem');
    await mkdir(cwd, { recursive: true });
    await promoteToSemantic(cwd, 'Rule alpha', 'Project Conventions');
    await promoteToSemantic(cwd, 'Rule beta', 'Failure Patterns');
    const stats = await getMemoryStats(cwd);
    assert.equal(stats.semantic_rules, 2);
  });

  it('counts procedural entries correctly', async () => {
    const cwd = join(tempDir, 'stats-proc');
    await mkdir(cwd, { recursive: true });
    await appendProcedural(cwd, { tool: 'bash', tags: [] });
    await appendProcedural(cwd, { tool: 'edit', tags: [] });
    await appendProcedural(cwd, { tool: 'read', tags: [] });
    const stats = await getMemoryStats(cwd);
    assert.equal(stats.procedural_entries, 3);
  });

  it('reports working_active as true when working.md has content', async () => {
    const cwd = join(tempDir, 'stats-working-true');
    await mkdir(cwd, { recursive: true });
    await updateWorkingMemory(cwd, '# Tasks\n- [ ] active task');
    const stats = await getMemoryStats(cwd);
    assert.equal(stats.working_active, true);
  });

  it('reports working_active as false when working.md is empty', async () => {
    const cwd = join(tempDir, 'stats-working-false');
    await mkdir(cwd, { recursive: true });
    await clearWorkingMemory(cwd);
    const stats = await getMemoryStats(cwd);
    assert.equal(stats.working_active, false);
  });
});
