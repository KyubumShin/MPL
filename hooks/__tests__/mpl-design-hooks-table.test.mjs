import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { liveHooksFromRoutes } from './helpers/introspect-routes.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');

function hookSection() {
  const design = readFileSync(join(ROOT, 'docs', 'design.md'), 'utf-8');
  const match = design.match(/## 7\. Hook System\n([\s\S]*?)\n---\n\n## 8\. Configuration Options/);
  assert.ok(match, 'docs/design.md must contain a bounded Section 7 Hook System');
  return match[1];
}

function splitMarkdownRow(row) {
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
}

function hookRows(section) {
  return section.split('\n').filter((line) => /^\| `mpl-/.test(line));
}

describe('docs/design.md Hook System table', () => {
  it('parses escaped pipes inside table cells', () => {
    assert.deepEqual(
      splitMarkdownRow('| `mpl-example` | PreToolUse | A \\| B | v0.test |'),
      ['`mpl-example`', 'PreToolUse', 'A | B', 'v0.test']
    );
  });

  it('lists every registered hook command from dispatch.mjs ROUTES', async () => {
    // Move #15: hooks.json was collapsed to a single mpl-engine entry per
    // event. The SSOT for "what's registered" is now dispatch.mjs ROUTES +
    // the MODULE_TO_HOOK_IDS expansion in lib/route-introspection.mjs.
    const section = hookSection();
    const live = await liveHooksFromRoutes();
    const documented = hookRows(section)
      .map((row) => splitMarkdownRow(row)[0])
      .map((cell) => cell.match(/^`(mpl-[^`]+)`$/)?.[1])
      .filter(Boolean)
      .sort();

    assert.deepEqual(documented, [...live.keys()]);
    assert.match(
      section,
      new RegExp(`MPL maintains pipeline integrity with ${live.size} registered hook commands`)
    );
    assert.doesNotMatch(section, /Drift note/);
    assert.doesNotMatch(section, /with 8 hooks/);
  });

  it('keeps one table row and an Introduced value per live hook', async () => {
    const section = hookSection();
    const live = await liveHooksFromRoutes();
    const rows = hookRows(section);

    assert.equal(rows.length, live.size);
    for (const row of rows) {
      const cells = splitMarkdownRow(row);
      assert.equal(cells.length, 4, row);
      assert.match(cells[0], /^`mpl-[^`]+`$/);
      const hookName = cells[0].slice(1, -1);
      assert.equal(cells[1], live.get(hookName), row);
      assert.notEqual(cells[2], '');
      assert.notEqual(cells[3], '');
    }
  });
});
