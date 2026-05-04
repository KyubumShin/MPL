import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  extractDeclarations,
  findReferences,
  runPropertyCheck,
  runBatch,
  DEFAULT_CONFIG_TARGETS,
} from '../lib/mpl-property-check.mjs';

const __filename = fileURLToPath(import.meta.url);
const CLI_PATH = join(dirname(__filename), '..', 'mpl-property-check.mjs');
const REAL_PLUGIN_ROOT = join(dirname(__filename), '..', '..');

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-pc-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function scaffold(files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

/* extractDeclarations ------------------------------------------------------ */

describe('extractDeclarations', () => {
  it('extracts top-level numeric/boolean/string properties', () => {
    const json = JSON.stringify({ min_tests: 50, strict: true, name: 'ok' });
    const decls = extractDeclarations(json);
    assert.deepStrictEqual(
      decls.map((d) => [d.key, d.value]),
      [['min_tests', 50], ['strict', true], ['name', 'ok']],
    );
  });

  it('flattens nested objects into dot-notation keys', () => {
    const json = JSON.stringify({ gates: { min_tests: 50, strict: false } });
    const decls = extractDeclarations(json);
    assert.deepStrictEqual(
      decls.map((d) => d.key).sort(),
      ['gates.min_tests', 'gates.strict'],
    );
  });

  it('skips arrays and null', () => {
    const json = JSON.stringify({ tags: ['a', 'b'], thing: null, count: 3 });
    const decls = extractDeclarations(json);
    assert.deepStrictEqual(decls.map((d) => d.key), ['count']);
  });

  it('skips leading-underscore keys (private metadata convention)', () => {
    const json = JSON.stringify({ _comment: 'ignored', strict: true });
    const decls = extractDeclarations(json);
    assert.deepStrictEqual(decls.map((d) => d.key), ['strict']);
  });

  it('returns [] on malformed JSON', () => {
    assert.deepStrictEqual(extractDeclarations('{ this is not json'), []);
  });

  it('returns [] when top level is not an object', () => {
    assert.deepStrictEqual(extractDeclarations('[]'), []);
    assert.deepStrictEqual(extractDeclarations('"string"'), []);
    assert.deepStrictEqual(extractDeclarations('42'), []);
  });

  it('preserves source attribution', () => {
    const decls = extractDeclarations('{"x": 1}', 'config/foo.json');
    assert.strictEqual(decls[0].source.file, 'config/foo.json');
  });
});

/* findReferences ----------------------------------------------------------- */

describe('findReferences', () => {
  it('matches member-access pattern (cfg.min_tests)', () => {
    scaffold({
      'src/app.ts': 'if (cfg.min_tests >= 50) { ... }\n',
      'config/c.json': '{"min_tests": 50}',
    });
    const refs = findReferences(tmp, 'min_tests');
    assert.strictEqual(refs.length, 1);
    assert.match(refs[0].file, /^src\/app\.ts$/);
  });

  it('matches subscript-access pattern', () => {
    scaffold({
      'src/a.ts': 'cfg["min_tests"]',
      'src/b.ts': 'cfg[\'min_tests\']',
    });
    const refs = findReferences(tmp, 'min_tests');
    assert.strictEqual(refs.length, 2);
  });

  it('matches function-arg string-literal pattern', () => {
    scaffold({
      'src/a.ts': "resolveRuleAction(cwd, state, 'min_tests')\n",
    });
    const refs = findReferences(tmp, 'min_tests');
    assert.strictEqual(refs.length, 1);
  });

  it('uses the leaf for nested keys', () => {
    scaffold({
      'src/app.ts': 'cfg.gates.min_tests > 0\n',
    });
    const refs = findReferences(tmp, 'gates.min_tests');
    assert.strictEqual(refs.length, 1);
  });

  it('skips configs (only code-extension files scanned)', () => {
    scaffold({
      'config/a.json': '{"min_tests": 1}',
      'config/b.json': '{"min_tests": 2}',
    });
    const refs = findReferences(tmp, 'min_tests');
    assert.strictEqual(refs.length, 0);
  });

  it('skips node_modules / .git / build output', () => {
    scaffold({
      'node_modules/lib/index.mjs': 'cfg.expected_tests\n',
      'dist/output.js': 'cfg.expected_tests\n',
      'src/main.ts': 'cfg.expected_tests\n',
    });
    const refs = findReferences(tmp, 'expected_tests');
    assert.strictEqual(refs.length, 1);
    assert.match(refs[0].file, /^src\/main\.ts$/);
  });

  it('PR #131 review: skips test files (__tests__, *.test.*, *.spec.*)', () => {
    scaffold({
      'hooks/__tests__/foo.test.mjs': 'cfg.min_tests\n',
      'src/foo.spec.ts': 'cfg.min_tests\n',
      'src/bar.test.ts': 'cfg.min_tests\n',
    });
    const refs = findReferences(tmp, 'min_tests');
    assert.strictEqual(refs.length, 0, 'test files must not count as consumers');
  });

  it('PR #131 review: skips property-check own implementation', () => {
    scaffold({
      'hooks/lib/mpl-property-check.mjs': "// example: cfg.expected_tests\n",
      'hooks/mpl-property-check.mjs': "console.log('expected_tests')\n",
    });
    const refs = findReferences(tmp, 'expected_tests');
    assert.strictEqual(refs.length, 0, 'property-check own files describe keys, not consume them');
  });

  it('PR #131 review: bare word in prose / import path is NOT a reference', () => {
    scaffold({
      // import path — `\.strict\b` member-access wouldn't match here, but the
      // old word-boundary regex did
      'src/a.ts': "import assert from 'node:assert/strict';\n",
      // prose-style comment
      'src/b.ts': "// strict mode: see docs\nconst x = 1;\n",
    });
    const refs = findReferences(tmp, 'strict');
    assert.strictEqual(refs.length, 0);
  });

  it('PR #131 review: standalone identifier (not member/subscript/string-arg) is NOT used', () => {
    scaffold({
      'src/a.ts': 'const tests = 50; expected_total = 60;\n',
    });
    const refs = findReferences(tmp, 'tests');
    assert.strictEqual(refs.length, 0,
      'bare assignment should NOT count — only code-shape access patterns do');
  });
});

/* runPropertyCheck --------------------------------------------------------- */

describe('runPropertyCheck', () => {
  it('partitions declarations into used/unused', () => {
    scaffold({
      'config/c.json': JSON.stringify({ min_tests: 50, expected_tests: 100 }),
      'src/used.ts': 'if (cfg.min_tests >= 1) {}\n',
    });
    const r = runPropertyCheck(tmp, 'config/c.json');
    assert.strictEqual(r.declarations.length, 2);
    assert.deepStrictEqual(r.used.map((u) => u.key), ['min_tests']);
    assert.deepStrictEqual(r.unused.map((u) => u.key), ['expected_tests']);
  });

  it('reports zero declarations when config absent', () => {
    const r = runPropertyCheck(tmp, 'config/missing.json');
    assert.deepStrictEqual(r.declarations, []);
  });

  it('used entries carry references[]', () => {
    scaffold({
      'config/c.json': JSON.stringify({ flag: true }),
      'src/a.ts': 'cfg.flag\n',
      'src/b.ts': 'cfg.flag\n',
    });
    const r = runPropertyCheck(tmp, 'config/c.json');
    assert.strictEqual(r.used[0].references.length, 2);
  });
});

/* runBatch + CLI ----------------------------------------------------------- */

describe('runBatch + CLI', () => {
  it('runBatch returns one result per config', () => {
    scaffold({
      'config/a.json': JSON.stringify({ x: 1 }),
      'config/b.json': JSON.stringify({ y: 2 }),
    });
    const results = runBatch(tmp, ['config/a.json', 'config/b.json']);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].configPath, 'config/a.json');
    assert.strictEqual(results[1].configPath, 'config/b.json');
  });

  it('CLI emits valid JSON with totals + per-config breakdown', () => {
    const out = execFileSync('node', [CLI_PATH, REAL_PLUGIN_ROOT, 'config/enforcement.json'], {
      encoding: 'utf-8',
    });
    const r = JSON.parse(out);
    assert.ok(typeof r.totals.declarations === 'number');
    assert.ok(typeof r.totals.used === 'number');
    assert.ok(typeof r.totals.unused === 'number');
    assert.ok(Array.isArray(r.configs));
  });

  it('CLI exits 2 when pluginRoot is missing', () => {
    let exit = 0;
    try {
      execFileSync('node', [CLI_PATH, '/definitely/not/a/path'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (e) { exit = e.status ?? -1; }
    assert.strictEqual(exit, 2);
  });

  it('default config targets are exposed', () => {
    assert.ok(DEFAULT_CONFIG_TARGETS.includes('config/enforcement.json'));
    assert.ok(DEFAULT_CONFIG_TARGETS.includes('.mpl/config.json'));
  });

  it('real-root self-run: only known forward-compat keys may be unused', () => {
    // Regression guard. The allow-list documents declarations whose consumer
    // is shipped by a later issue — when that issue lands, the key drops out
    // of unused naturally and any NEW unused declarations surface here.
    const EXPECTED_UNUSED = [
      'enforcement.missing_artifact_schema', // P0-K (#115) ships the consumer
    ];
    const out = execFileSync('node', [CLI_PATH, REAL_PLUGIN_ROOT, 'config/enforcement.json'], {
      encoding: 'utf-8',
    });
    const r = JSON.parse(out);
    const cfg = r.configs.find((c) => c.configPath === 'config/enforcement.json');
    assert.ok(cfg, 'enforcement.json result expected');
    const surprises = cfg.unused
      .map((u) => u.key)
      .filter((k) => !EXPECTED_UNUSED.includes(k));
    assert.deepStrictEqual(
      surprises, [],
      `enforcement.json has new unused declarations not on the allow-list: ${surprises.join(', ')}`,
    );
  });
});
