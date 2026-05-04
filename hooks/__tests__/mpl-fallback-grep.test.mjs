import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  parseRegistry,
  compileRegistry,
  isInScope,
  scanContent,
  decideAction,
  loadRegistry,
} from '../lib/anti-pattern-registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const REGISTRY_PATH = join(PLUGIN_ROOT, 'commands', 'references', 'anti-patterns.md');
const HOOK_PATH = join(__dirname, '..', 'mpl-fallback-grep.mjs');

describe('parseRegistry', () => {
  it('parses scope blocks (allowed + excluded)', () => {
    const md = `
\`\`\`scope
.mjs .ts .py
.rs
\`\`\`

\`\`\`scope-excluded
.md .json
*.test.{ts,tsx}
\`\`\`
`;
    const { scope } = parseRegistry(md);
    assert.ok(scope.allowed.has('.mjs'));
    assert.ok(scope.allowed.has('.ts'));
    assert.ok(scope.allowed.has('.py'));
    assert.ok(scope.allowed.has('.rs'));
    assert.ok(scope.excluded.has('.md'));
    assert.ok(scope.excluded.has('.json'));
    assert.ok(scope.excluded.has('*.test.{ts,tsx}'));
  });

  it('parses pattern heading + frontmatter + regex + permitted-when', () => {
    const md = `
### TC1 · Tautological assertion

- **id**: \`TC1\`
- **category**: \`test-fake\`
- **severity**: \`block\`
- **escalation**: tier_3_block_in: production
- **rationale**: SUT-independent
- **ground-truth count**: 5

\`\`\`regex
expect\\s*\\(\\s*true\\s*\\)
assert\\s*\\(\\s*true\\s*\\)
\`\`\`

\`\`\`permitted-when
- inside an environment precondition test
\`\`\`
`;
    const { patterns } = parseRegistry(md);
    assert.strictEqual(patterns.length, 1);
    const p = patterns[0];
    assert.strictEqual(p.id, 'TC1');
    assert.strictEqual(p.title, 'Tautological assertion');
    assert.strictEqual(p.category, 'test-fake');
    assert.strictEqual(p.severity, 'block');
    assert.deepStrictEqual(p.escalation, ['tier_3_block_in:production']);
    assert.strictEqual(p.regexLines.length, 2);
    assert.match(p.permittedWhen, /environment precondition/);
  });

  it('parses real registry into 10 patterns', () => {
    const md = readFileSync(REGISTRY_PATH, 'utf-8');
    const { patterns, scope } = parseRegistry(md);
    assert.strictEqual(patterns.length, 10);
    const ids = patterns.map(p => p.id).sort();
    assert.deepStrictEqual(ids, ['C2', 'C3', 'CSP', 'D1.a', 'D1.b', 'D2', 'M1', 'TC1', 'TC2', 'TC3']);
    assert.ok(scope.allowed.has('.mjs'));
    assert.ok(scope.allowed.has('.ts'));
    assert.ok(scope.excluded.has('.md'));
  });

  it('parses bullet value when trailing prose follows backticked token (PR #122 review)', () => {
    // Pre-fix bug: regex required `\s*$` after the optional closing backtick, dropping
    // any line that had explanatory prose after the backticked value. Real registry
    // entries (C2/C3/M1/CSP/D1.a/TC1) all carry such prose. With the bug, escalation
    // was [] for those patterns and strict-mode F3 erroneously blocked C3 (severity=block,
    // tier_3_only) instead of deferring to Tier 3.
    const md = `
### XX · Test pattern

- **id**: \`XX\`
- **category**: \`test-fake\`
- **severity**: \`block\`
- **escalation**: \`tier_3_only\` (Tier 1 emits warn only — explanatory prose after backtick)
- **rationale**: arbitrary prose with no backticks
- **ground-truth count**: 5 (exp15)

\`\`\`regex
foo
\`\`\`
`;
    const { patterns } = parseRegistry(md);
    assert.strictEqual(patterns.length, 1);
    const p = patterns[0];
    assert.strictEqual(p.id, 'XX');
    assert.strictEqual(p.category, 'test-fake');
    assert.strictEqual(p.severity, 'block');
    assert.deepStrictEqual(p.escalation, ['tier_3_only']);
    assert.match(p.rationale, /arbitrary prose/);
    assert.match(p.groundTruthCount, /5 \(exp15\)/);
  });

  it('real registry: every escalation-bearing pattern parses non-empty escalation', () => {
    const reg = loadRegistry(REGISTRY_PATH);
    // From the registry source-of-truth, these patterns explicitly declare escalation:
    const expected = {
      'TC1': ['tier_3_block_in:production'],
      'TC2': ['strict_block'],
      'C2':  ['tier_3_block_in:production'],
      'C3':  ['tier_3_only'],
      'M1':  ['tier_3_block_in:production'],
      'CSP': ['tier_3_only'],
      'D1.a': ['tier_3_block_in:verification-result-LHS'],
    };
    for (const [id, exp] of Object.entries(expected)) {
      const p = reg.patterns.find(x => x.id === id);
      assert.ok(p, `${id} pattern present`);
      assert.deepStrictEqual(p.escalation, exp, `${id} escalation should be ${JSON.stringify(exp)}`);
    }
    // And patterns that intentionally omit escalation:
    for (const id of ['TC3', 'D1.b', 'D2']) {
      const p = reg.patterns.find(x => x.id === id);
      assert.deepStrictEqual(p.escalation, [], `${id} has no escalation field`);
    }
  });

  it('real registry: every severity is the bare enum (no compound text)', () => {
    const reg = loadRegistry(REGISTRY_PATH);
    for (const p of reg.patterns) {
      assert.ok(['block', 'warn'].includes(p.severity),
        `${p.id} severity must be 'block' or 'warn', got '${p.severity}'`);
    }
  });
});

describe('compileRegistry', () => {
  it('compiles real registry without dropping any regexes', () => {
    const reg = loadRegistry(REGISTRY_PATH);
    assert.strictEqual(reg.dropped, 0);
    for (const p of reg.patterns) {
      assert.ok(p.compiled.length > 0, `${p.id} has at least one regex`);
      for (const re of p.compiled) assert.ok(re instanceof RegExp);
    }
  });
});

describe('isInScope', () => {
  const scope = { allowed: new Set(['.mjs', '.ts', '.py']), excluded: new Set(['.md', '*.test.{ts,tsx}']) };

  it('accepts allowed extensions', () => {
    assert.strictEqual(isInScope('/repo/src/foo.ts', scope), true);
    assert.strictEqual(isInScope('/repo/lib/bar.mjs', scope), true);
  });

  it('rejects extensions not in allowlist', () => {
    assert.strictEqual(isInScope('/repo/README.md', scope), false);
    assert.strictEqual(isInScope('/repo/config.json', scope), false);
  });

  it('rejects excluded glob patterns (*.test.ts)', () => {
    assert.strictEqual(isInScope('/repo/src/foo.test.ts', scope), false);
    assert.strictEqual(isInScope('/repo/src/foo.test.tsx', scope), false);
  });

  it('rejects registry doc itself (self-application contract)', () => {
    assert.strictEqual(isInScope('/repo/commands/references/anti-patterns.md', scope), false);
  });

  it('rejects agent prompts (registry self-doc surface)', () => {
    // .md is already excluded by extension, but explicit guard is still tested
    const broadScope = { allowed: new Set(['.md', '.mjs']), excluded: new Set() };
    assert.strictEqual(isInScope('/repo/agents/mpl-phase-runner.md', broadScope), false);
  });

  it('handles missing file path', () => {
    assert.strictEqual(isInScope('', scope), false);
    assert.strictEqual(isInScope(null, scope), false);
  });
});

describe('scanContent', () => {
  const registry = loadRegistry(REGISTRY_PATH);

  it('TC1 fixture (positive) → match', () => {
    const src = `
import { test, expect } from 'vitest';
test('foo', () => {
  expect(true).toBe(true);
});
`;
    const hits = scanContent(src, registry.patterns);
    const tc1 = hits.filter(h => h.id === 'TC1');
    assert.ok(tc1.length >= 1);
  });

  it('TC1 fixture (negative — real assertion) → no match', () => {
    const src = `
import { test, expect } from 'vitest';
test('foo', () => {
  expect(add(2, 2)).toBe(4);
});
`;
    const hits = scanContent(src, registry.patterns);
    assert.strictEqual(hits.filter(h => h.id === 'TC1').length, 0);
  });

  it('M1 fixture → match', () => {
    const src = `const x = obj as unknown as MyType;`;
    const hits = scanContent(src, registry.patterns);
    assert.ok(hits.filter(h => h.id === 'M1').length >= 1);
  });

  it('D2 fixture (swallowed reject) → match', () => {
    const src = `await fetch(url).catch(() => false);`;
    const hits = scanContent(src, registry.patterns);
    assert.ok(hits.filter(h => h.id === 'D2').length >= 1);
  });

  it('D1.b synthetic-id literal → match', () => {
    const src = `const id = \`no-git-\${Date.now()}\`;`;
    const hits = scanContent(src, registry.patterns);
    assert.ok(hits.filter(h => h.id === 'D1.b').length >= 1);
  });

  it('clean source → no hits in block-severity patterns', () => {
    const src = `
function add(a, b) { return a + b; }
export { add };
`;
    const hits = scanContent(src, registry.patterns);
    const blockIds = ['TC1', 'TC2', 'TC3', 'C3', 'D1.b', 'D2'];
    const blockHits = hits.filter(h => blockIds.includes(h.id));
    assert.strictEqual(blockHits.length, 0);
  });

  it('reports line numbers + snippets', () => {
    const src = `// header line\n// another\nexpect(true).toBe(true);`;
    const hits = scanContent(src, registry.patterns).filter(h => h.id === 'TC1');
    assert.ok(hits[0]);
    assert.strictEqual(hits[0].line, 3);
    assert.match(hits[0].snippet, /expect\(true\)\.toBe\(true\)/);
  });
});

describe('decideAction', () => {
  it('no hits → silent', () => {
    const r = decideAction([], { strict: false });
    assert.strictEqual(r.action, 'silent');
  });

  it('hits + non-strict → warn', () => {
    const r = decideAction([{ id: 'TC1', severity: 'block', escalation: [] }], { strict: false });
    assert.strictEqual(r.action, 'warn');
    assert.match(r.summary, /TC1/);
  });

  it('block-severity hit + strict → block', () => {
    const r = decideAction([{ id: 'TC1', severity: 'block', escalation: [] }], { strict: true });
    assert.strictEqual(r.action, 'block');
    assert.strictEqual(r.blocking.length, 1);
  });

  it('warn-severity hit + strict → still warn (Tier 1 cannot semantically validate)', () => {
    const r = decideAction([{ id: 'M1', severity: 'warn', escalation: ['tier_3_block_in:production'] }], { strict: true });
    assert.strictEqual(r.action, 'warn');
  });

  it('block-severity + tier_3_only escalation + strict → warn (defer to Tier 3)', () => {
    const r = decideAction([{ id: 'C3', severity: 'block', escalation: ['tier_3_only'] }], { strict: true });
    assert.strictEqual(r.action, 'warn');
  });

  it('PR #122 review repro — real-registry C3 hit + strict → warn (not block)', () => {
    // Reviewer's exact repro:
    //   const c3 = r.patterns.find(p => p.id === 'C3');
    //   const hits = scanContent('console.log("INV-123 PASS");', [c3]);
    //   decideAction(hits, {strict: true}).action  // should be 'warn', was 'block'
    // Root cause: parser dropped the `tier_3_only` escalation due to trailing prose.
    const reg = loadRegistry(REGISTRY_PATH);
    const c3 = reg.patterns.find(p => p.id === 'C3');
    const hits = scanContent('console.log("INV-123 PASS");', [c3]);
    assert.ok(hits.length > 0, 'C3 must match the silent INV PASS pattern');
    const decision = decideAction(hits, { strict: true });
    assert.strictEqual(decision.action, 'warn');
    assert.deepStrictEqual(decision.blocking, []);
  });
});

describe('mpl-fallback-grep hook integration', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-fbgrep-'));
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({ current_phase: 'phase2-sprint' }));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function runHook(toolName, toolInput, extraState) {
    if (extraState) {
      const cur = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
      writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({ ...cur, ...extraState }));
    }
    const stdin = JSON.stringify({
      cwd: tmpDir,
      tool_name: toolName,
      tool_input: toolInput,
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    return JSON.parse(out);
  }

  it('non-Edit/Write tool → silent', () => {
    const r = runHook('Bash', { command: 'ls' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('Edit on .md file (registry self-doc) → silent (path-extension excluded)', () => {
    const md = join(tmpDir, 'doc.md');
    writeFileSync(md, 'expect(true).toBe(true)');
    const r = runHook('Edit', { file_path: md, old_string: 'a', new_string: 'b' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('Edit on .ts with TC1 violation → warn (non-strict default)', () => {
    const ts = join(tmpDir, 'foo.ts');
    writeFileSync(ts, 'test("x", () => { expect(true).toBe(true); });\n');
    const r = runHook('Edit', { file_path: ts, old_string: 'a', new_string: 'b' });
    assert.strictEqual(r.continue, true);
    assert.match(r.systemMessage, /Tier 1 anti-pattern advisory/);
    assert.match(r.systemMessage, /TC1/);
  });

  it('Edit on .ts with TC1 violation + strict mode → block', () => {
    const ts = join(tmpDir, 'foo.ts');
    writeFileSync(ts, 'test("x", () => { expect(true).toBe(true); });\n');
    const r = runHook('Edit', { file_path: ts, old_string: 'a', new_string: 'b' }, { enforcement: { strict: true } });
    assert.strictEqual(r.decision, 'block');
    assert.match(r.reason, /strict mode anti-pattern block/);
    assert.match(r.reason, /TC1/);
  });

  it('Edit on clean .ts file → silent', () => {
    const ts = join(tmpDir, 'foo.ts');
    writeFileSync(ts, 'export function add(a, b) { return a + b; }\n');
    const r = runHook('Edit', { file_path: ts, old_string: 'a', new_string: 'b' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('Edit on .ts with M1 (warn-severity) + strict → still warn (Tier 1 limitation)', () => {
    const ts = join(tmpDir, 'foo.ts');
    writeFileSync(ts, 'const x = obj as unknown as MyType;\n');
    const r = runHook('Edit', { file_path: ts, old_string: 'a', new_string: 'b' }, { enforcement: { strict: true } });
    assert.strictEqual(r.continue, true);
    assert.match(r.systemMessage, /M1/);
    assert.notStrictEqual(r.decision, 'block');
  });

  it('writes hits to .mpl/signals/anti-pattern-hits.jsonl', () => {
    const ts = join(tmpDir, 'foo.ts');
    writeFileSync(ts, 'test("x", () => { expect(true).toBe(true); });\n');
    runHook('Edit', { file_path: ts, old_string: 'a', new_string: 'b' });
    const sig = join(tmpDir, '.mpl', 'signals', 'anti-pattern-hits.jsonl');
    assert.ok(existsSync(sig));
    const lines = readFileSync(sig, 'utf-8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1);
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.id, 'TC1');
    assert.strictEqual(rec.action, 'warn');
    assert.ok(rec.line);
    assert.match(rec.file, /foo\.ts$/);
  });

  it('MPL not active → silent', () => {
    rmSync(join(tmpDir, '.mpl'), { recursive: true });
    const ts = join(tmpDir, 'foo.ts');
    writeFileSync(ts, 'expect(true).toBe(true);\n');
    const r = runHook('Edit', { file_path: ts, old_string: 'a', new_string: 'b' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });
});
