import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');

function formatEventMatcher(event, matcher) {
  return matcher ? `${event}: ${matcher.replaceAll('|', '/')}` : event;
}

function liveHooks() {
  const registry = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf-8'));
  const hooks = new Map();

  for (const [event, registrations] of Object.entries(registry.hooks || {})) {
    for (const registration of registrations) {
      for (const hook of registration.hooks || []) {
        const match = String(hook.command || '').match(/hooks\/(mpl-[^" ]+)\.mjs/);
        if (!match) continue;

        const name = match[1];
        const eventMatcher = formatEventMatcher(event, registration.matcher || '');
        const existing = hooks.get(name);
        hooks.set(name, existing ? `${existing}; ${eventMatcher}` : eventMatcher);
      }
    }
  }

  return new Map([...hooks.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

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

  it('lists every registered hook command from hooks/hooks.json', () => {
    const section = hookSection();
    const live = liveHooks();
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

  it('keeps one table row and an Introduced value per live hook', () => {
    const section = hookSection();
    const live = liveHooks();
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
