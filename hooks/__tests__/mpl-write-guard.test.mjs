import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedPath, isSourceFile } from '../mpl-write-guard.mjs';

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
