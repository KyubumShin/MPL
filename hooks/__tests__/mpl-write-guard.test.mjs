import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { isAllowedPath, isSourceFile } from '../mpl-write-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-write-guard.mjs');

describe('isAllowedPath', () => {
  it('should allow .mpl/ paths', () => {
    assert.strictEqual(isAllowedPath('.mpl/state.json'), true);
    assert.strictEqual(isAllowedPath('/project/.mpl/config.json'), true);
  });

  it('should allow .omc/ paths', () => {
    assert.strictEqual(isAllowedPath('.omc/state.json'), true);
    assert.strictEqual(isAllowedPath('/project/.omc/notepad.md'), true);
  });

  it('should allow .claude/ paths', () => {
    assert.strictEqual(isAllowedPath('.claude/settings.json'), true);
    assert.strictEqual(isAllowedPath('/home/user/.claude/config'), true);
  });

  it('should allow PLAN.md', () => {
    assert.strictEqual(isAllowedPath('PLAN.md'), true);
    assert.strictEqual(isAllowedPath('/project/PLAN.md'), true);
  });

  it('should allow MPL/ plugin directory', () => {
    assert.strictEqual(isAllowedPath('/project/MPL/hooks/test.mjs'), true);
  });

  it('should allow docs/learnings/ paths', () => {
    assert.strictEqual(isAllowedPath('docs/learnings/feature/notes.md'), true);
  });

  it('should NOT allow src/app.ts', () => {
    assert.strictEqual(isAllowedPath('src/app.ts'), false);
  });

  it('should NOT allow regular source files', () => {
    assert.strictEqual(isAllowedPath('lib/utils.js'), false);
    assert.strictEqual(isAllowedPath('main.py'), false);
  });

  it('should return true for null/empty path', () => {
    assert.strictEqual(isAllowedPath(null), true);
    assert.strictEqual(isAllowedPath(''), true);
  });
});

describe('isSourceFile', () => {
  it('should recognize TypeScript files', () => {
    assert.strictEqual(isSourceFile('app.ts'), true);
    assert.strictEqual(isSourceFile('component.tsx'), true);
  });

  it('should recognize JavaScript files', () => {
    assert.strictEqual(isSourceFile('index.js'), true);
    assert.strictEqual(isSourceFile('util.jsx'), true);
    assert.strictEqual(isSourceFile('config.mjs'), true);
    assert.strictEqual(isSourceFile('module.cjs'), true);
  });

  it('should recognize Python files', () => {
    assert.strictEqual(isSourceFile('main.py'), true);
  });

  it('should recognize Go files', () => {
    assert.strictEqual(isSourceFile('main.go'), true);
  });

  it('should recognize Rust files', () => {
    assert.strictEqual(isSourceFile('lib.rs'), true);
  });

  it('should recognize Java files', () => {
    assert.strictEqual(isSourceFile('App.java'), true);
  });

  it('should recognize C/C++ files', () => {
    assert.strictEqual(isSourceFile('main.c'), true);
    assert.strictEqual(isSourceFile('lib.cpp'), true);
    assert.strictEqual(isSourceFile('header.h'), true);
  });

  it('should recognize Svelte and Vue files', () => {
    assert.strictEqual(isSourceFile('App.svelte'), true);
    assert.strictEqual(isSourceFile('Page.vue'), true);
  });

  it('should NOT recognize .md files as source', () => {
    assert.strictEqual(isSourceFile('README.md'), false);
  });

  it('should NOT recognize .txt files as source', () => {
    assert.strictEqual(isSourceFile('notes.txt'), false);
  });

  it('should return false for null/empty path', () => {
    assert.strictEqual(isSourceFile(null), false);
    assert.strictEqual(isSourceFile(''), false);
  });
});

/* ────────────────────────── P0-3 (#111) ──────────────────────────────── */

describe('isAllowedPath dogfood mode (P0-3, #111)', () => {
  it('default mode keeps /MPL/ allowed', () => {
    assert.strictEqual(isAllowedPath('/proj/MPL/hooks/x.mjs', { dogfood: false }), true);
    // backwards-compat without opts
    assert.strictEqual(isAllowedPath('/proj/MPL/hooks/x.mjs'), true);
  });
  it('dogfood mode strips /MPL/ from allowlist', () => {
    assert.strictEqual(isAllowedPath('/proj/MPL/hooks/x.mjs', { dogfood: true }), false);
  });
  it('dogfood mode does not affect .mpl/ / .claude/', () => {
    assert.strictEqual(isAllowedPath('/proj/.mpl/state.json', { dogfood: true }), true);
    assert.strictEqual(isAllowedPath('/proj/.claude/settings.json', { dogfood: true }), true);
  });
});

describe('mpl-write-guard hook integration (P0-3, #111)', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mpl-wg-'));
    mkdirSync(join(tmp, '.mpl'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({ current_phase: 'phase2-sprint' }));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function runHook(toolName, toolInput, extraConfig, env) {
    if (extraConfig) {
      writeFileSync(join(tmp, '.mpl', 'config.json'), JSON.stringify(extraConfig));
    }
    const stdin = JSON.stringify({
      cwd: tmp,
      tool_name: toolName,
      tool_input: toolInput,
    });
    const out = execFileSync('node', [HOOK_PATH], {
      input: stdin,
      encoding: 'utf-8',
      env: { ...process.env, ...(env || {}) },
    });
    return JSON.parse(out);
  }

  it('default (warn) on source file outside allowlist → continue + delegation notice', () => {
    const r = runHook('Edit', {
      file_path: join(tmp, 'src', 'app.ts'),
      old_string: 'a',
      new_string: 'b',
    });
    assert.strictEqual(r.continue, true);
    assert.match(r.hookSpecificOutput?.additionalContext || '', /MPL DELEGATION NOTICE/);
  });

  it('strict mode (P0-2) elevates direct_source_edit warn → block', () => {
    const r = runHook('Edit', {
      file_path: join(tmp, 'src', 'app.ts'),
      old_string: 'a',
      new_string: 'b',
    }, { enforcement: { strict: true } });
    assert.strictEqual(r.decision, 'block');
    assert.match(r.reason, /MPL DELEGATION NOTICE/);
  });

  it('direct_source_edit: "block" + strict false → block', () => {
    const r = runHook('Edit', {
      file_path: join(tmp, 'src', 'app.ts'),
      old_string: 'a',
      new_string: 'b',
    }, { enforcement: { direct_source_edit: 'block' } });
    assert.strictEqual(r.decision, 'block');
  });

  it('direct_source_edit: "off" + strict true → silent (explicit opt-out)', () => {
    const r = runHook('Edit', {
      file_path: join(tmp, 'src', 'app.ts'),
      old_string: 'a',
      new_string: 'b',
    }, { enforcement: { strict: true, direct_source_edit: 'off' } });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('dogfood mode (config) + edit on /MPL/ source → delegation notice, not silent', () => {
    const r = runHook('Edit', {
      file_path: '/proj/MPL/hooks/test.mjs',
      old_string: 'a',
      new_string: 'b',
    }, { dogfood: true });
    assert.strictEqual(r.continue, true);
    assert.match(r.hookSpecificOutput?.additionalContext || '', /MPL DELEGATION NOTICE/);
    assert.match(r.hookSpecificOutput?.additionalContext || '', /dogfood mode/);
  });

  it('dogfood mode (env MPL_DOGFOOD=1) toggles equally', () => {
    const r = runHook('Edit', {
      file_path: '/proj/MPL/hooks/test.mjs',
      old_string: 'a',
      new_string: 'b',
    }, null, { MPL_DOGFOOD: '1' });
    assert.match(r.hookSpecificOutput?.additionalContext || '', /MPL DELEGATION NOTICE/);
  });

  it('non-dogfood + /MPL/ source still allowed (backwards-compat)', () => {
    const r = runHook('Edit', {
      file_path: '/proj/MPL/hooks/test.mjs',
      old_string: 'a',
      new_string: 'b',
    });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('allowed path .mpl/ → silent regardless of policy', () => {
    const r = runHook('Edit', {
      file_path: join(tmp, '.mpl', 'memory', 'working.md'),
      old_string: 'a',
      new_string: 'b',
    }, { enforcement: { strict: true, direct_source_edit: 'block' } });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('non-source file outside allowed (e.g. .md outside docs/learnings) → silent (no source rule)', () => {
    // .md is not in SOURCE_EXTENSIONS, so direct_source_edit doesn't fire.
    // Phase scope check only triggers when decomposition.yaml declares scope; here it doesn't.
    const r = runHook('Edit', {
      file_path: join(tmp, 'README.md'),
      old_string: 'a',
      new_string: 'b',
    });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('Bash dangerous command still warns (existing behaviour preserved)', () => {
    const r = runHook('Bash', { command: 'rm -rf /tmp/foo' });
    assert.strictEqual(r.continue, true);
    assert.match(r.hookSpecificOutput?.additionalContext || '', /MPL SAFETY WARNING/);
  });

  it('MPL inactive → silent regardless of policy', () => {
    rmSync(join(tmp, '.mpl'), { recursive: true });
    const r = runHook('Edit', {
      file_path: join(tmp, 'src', 'app.ts'),
      old_string: 'a',
      new_string: 'b',
    });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });
});
