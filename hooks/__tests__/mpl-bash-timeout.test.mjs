import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  CATEGORIES,
  classifyCommand,
  decideTimeout,
} from '../lib/bash-timeout-categories.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-bash-timeout.mjs');

describe('classifyCommand', () => {
  it('classifies vitest / jest / npm test', () => {
    assert.strictEqual(classifyCommand('vitest run').name, 'vitest-jest');
    assert.strictEqual(classifyCommand('npx jest --watch=false').name, 'vitest-jest');
    assert.strictEqual(classifyCommand('npm test').name, 'vitest-jest');
    assert.strictEqual(classifyCommand('pnpm run test').name, 'vitest-jest');
  });

  it('classifies playwright', () => {
    assert.strictEqual(classifyCommand('npx playwright test').name, 'playwright');
    assert.strictEqual(classifyCommand('playwright test').name, 'playwright');
    assert.strictEqual(classifyCommand('playwright install').name, 'playwright');
  });

  it('does NOT match `pw test` (non-standard alias, removed for collision safety)', () => {
    // `pw` is not the canonical playwright binary; it collides with `pwgen` and other
    // user aliases. Use `playwright` or `npx playwright` instead.
    assert.strictEqual(classifyCommand('pw test'), null);
  });

  it('classifies build commands', () => {
    assert.strictEqual(classifyCommand('tsc').name, 'build');
    assert.strictEqual(classifyCommand('vite build').name, 'build');
    assert.strictEqual(classifyCommand('cargo build --release').name, 'build');
    assert.strictEqual(classifyCommand('npm run build').name, 'build');
    assert.strictEqual(classifyCommand('./gradlew compileJava').name, 'build');
    assert.strictEqual(classifyCommand('./gradlew build').name, 'build');
    assert.strictEqual(classifyCommand('mvn compile -q').name, 'build');
    assert.strictEqual(classifyCommand('mvn package').name, 'build');
  });

  it('classifies typecheck/lint (tsc --noEmit / eslint / ruff)', () => {
    assert.strictEqual(classifyCommand('tsc --noEmit').name, 'typecheck-lint');
    assert.strictEqual(classifyCommand('npx eslint src/').name, 'typecheck-lint');
    assert.strictEqual(classifyCommand('ruff check .').name, 'typecheck-lint');
  });

  it('classifies MPL gate-generated typecheck-lint commands (#107 review fix)', () => {
    // commands/mpl-run-execute-gates.md emits these — they MUST be enforced.
    assert.strictEqual(classifyCommand('npm run typecheck').name, 'typecheck-lint');
    assert.strictEqual(classifyCommand('pnpm run typecheck').name, 'typecheck-lint');
    assert.strictEqual(classifyCommand('yarn typecheck').name, 'typecheck-lint');
    assert.strictEqual(classifyCommand('npm run lint').name, 'typecheck-lint');
    assert.strictEqual(classifyCommand('cd src-tauri && cargo check').name, 'typecheck-lint');
    assert.strictEqual(
      classifyCommand("python -m py_compile $(find . -name '*.py')").name,
      'typecheck-lint',
    );
    assert.strictEqual(classifyCommand('flake8 .').name, 'typecheck-lint');
    assert.strictEqual(classifyCommand('npx biome check .').name, 'typecheck-lint');
  });

  it('returns null for non-verification commands', () => {
    assert.strictEqual(classifyCommand('ls -la'), null);
    assert.strictEqual(classifyCommand('git status'), null);
    assert.strictEqual(classifyCommand('echo hello'), null);
    assert.strictEqual(classifyCommand(''), null);
    assert.strictEqual(classifyCommand(null), null);
  });

  it('disambiguates tsc (build) vs tsc --noEmit (typecheck)', () => {
    // tsc with no flags → build category (emits files, longer timeout)
    assert.strictEqual(classifyCommand('tsc').name, 'build');
    assert.strictEqual(classifyCommand('tsc -p tsconfig.json').name, 'build');
    // tsc --noEmit → typecheck (faster, lower ceiling)
    assert.strictEqual(classifyCommand('tsc --noEmit').name, 'typecheck-lint');
  });

  it('tsc with intermediate flags + --noEmit anywhere → typecheck-lint (#107 review fix)', () => {
    // Prior implementation used a negative lookahead that only checked the first token
    // after `tsc`, so `tsc -p tsconfig.json --noEmit` was misclassified as build.
    assert.strictEqual(classifyCommand('tsc -p tsconfig.json --noEmit').name, 'typecheck-lint');
    assert.strictEqual(classifyCommand('tsc --project ./packages/foo --noEmit').name, 'typecheck-lint');
    assert.strictEqual(classifyCommand('npx tsc -p tsconfig.json --noEmit').name, 'typecheck-lint');
    // Reverse — `tsc -p ...` without --noEmit is still build
    assert.strictEqual(classifyCommand('tsc -p tsconfig.json').name, 'build');
  });

  it('first-match wins (playwright before vitest-jest)', () => {
    // A theoretical command that matches both: playwright should win because it's narrower
    // (Real example: "npx playwright test" matches playwright pattern, not the npm-test one)
    const c = classifyCommand('npx playwright test');
    assert.strictEqual(c.name, 'playwright');
  });
});

describe('decideTimeout', () => {
  it('non-verification command → silent', () => {
    const r = decideTimeout('ls -la', undefined);
    assert.strictEqual(r.action, 'silent');
    assert.strictEqual(r.category, null);
  });

  it('vitest + no timeout (non-strict) → warn with recommended', () => {
    const r = decideTimeout('vitest run', undefined, { strict: false });
    assert.strictEqual(r.action, 'warn');
    assert.strictEqual(r.category, 'vitest-jest');
    assert.strictEqual(r.recommendedMs, 300_000);
    assert.match(r.reason, /needs an explicit timeout/);
  });

  it('vitest + no timeout (strict) → block', () => {
    const r = decideTimeout('vitest run', undefined, { strict: true });
    assert.strictEqual(r.action, 'block');
    assert.strictEqual(r.recommendedMs, 300_000);
  });

  it('vitest + timeout in range → silent', () => {
    const r = decideTimeout('vitest run', 240_000);
    assert.strictEqual(r.action, 'silent');
  });

  it('vitest + timeout below sanity floor → warn (typo guard)', () => {
    // 200 ms is almost certainly a typo for 200000 ms
    const r = decideTimeout('vitest run', 200);
    assert.strictEqual(r.action, 'warn');
    assert.match(r.reason, /below the sanity floor/);
  });

  it('vitest + timeout above ceiling (non-strict) → warn', () => {
    const r = decideTimeout('vitest run', 1_200_000);  // 20 min
    assert.strictEqual(r.action, 'warn');
    assert.match(r.reason, /exceeds the per-call ceiling/);
  });

  it('vitest + timeout above ceiling (strict) → block', () => {
    const r = decideTimeout('vitest run', 1_200_000, { strict: true });
    assert.strictEqual(r.action, 'block');
  });

  it('playwright timeout up to 600000ms accepted', () => {
    assert.strictEqual(decideTimeout('npx playwright test', 600_000).action, 'silent');
    assert.strictEqual(decideTimeout('npx playwright test', 599_999).action, 'silent');
    assert.strictEqual(decideTimeout('npx playwright test', 600_001, { strict: true }).action, 'block');
  });

  it('build (tsc) within 30s-180s window', () => {
    assert.strictEqual(decideTimeout('tsc', 60_000).action, 'silent');
    assert.strictEqual(decideTimeout('tsc', 200_000, { strict: true }).action, 'block');
    assert.strictEqual(decideTimeout('tsc', 5_000).action, 'warn');  // below floor
  });

  it('typecheck-lint within 10s-120s window', () => {
    assert.strictEqual(decideTimeout('tsc --noEmit', 60_000).action, 'silent');
    assert.strictEqual(decideTimeout('eslint src/', 30_000).action, 'silent');
    assert.strictEqual(decideTimeout('eslint src/', 200_000, { strict: true }).action, 'block');
  });

  it('rejects bogus timeout values (negative, NaN, 0)', () => {
    // These all act as "missing" → warn with recommended
    assert.strictEqual(decideTimeout('vitest run', 0).action, 'warn');
    assert.strictEqual(decideTimeout('vitest run', -100).action, 'warn');
    assert.strictEqual(decideTimeout('vitest run', NaN).action, 'warn');
  });
});

describe('mpl-bash-timeout hook integration', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-bashtimeout-'));
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({ current_phase: 'phase2-sprint' }));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function runHook(toolName, toolInput, extraState) {
    if (extraState) {
      const state = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
      writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({ ...state, ...extraState }));
    }
    const stdin = JSON.stringify({
      cwd: tmpDir,
      tool_name: toolName,
      tool_input: toolInput,
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    return JSON.parse(out);
  }

  it('non-Bash tool → silent', () => {
    const r = runHook('Edit', { file_path: '/tmp/foo.ts', new_string: 'x', old_string: 'y' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('non-verification command (ls) → silent', () => {
    const r = runHook('Bash', { command: 'ls -la' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('vitest without timeout (non-strict) → warn (not block)', () => {
    const r = runHook('Bash', { command: 'vitest run' });
    assert.strictEqual(r.continue, true);
    assert.match(r.systemMessage, /vitest-jest command needs an explicit timeout/);
    assert.notStrictEqual(r.decision, 'block');
  });

  it('vitest without timeout + strict → block', () => {
    const r = runHook('Bash', { command: 'vitest run' }, { enforcement: { strict: true } });
    assert.strictEqual(r.decision, 'block');
    assert.match(r.reason, /vitest-jest command needs an explicit timeout/);
  });

  it('vitest with sane timeout → silent', () => {
    const r = runHook('Bash', { command: 'vitest run --silent', timeout: 300_000 });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('playwright without timeout + strict → block', () => {
    const r = runHook('Bash', { command: 'npx playwright test' }, { enforcement: { strict: true } });
    assert.strictEqual(r.decision, 'block');
    assert.match(r.reason, /playwright/);
  });

  it('MPL not active → silent (no enforcement outside MPL)', () => {
    rmSync(join(tmpDir, '.mpl'), { recursive: true });
    const r = runHook('Bash', { command: 'vitest run' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });
});
