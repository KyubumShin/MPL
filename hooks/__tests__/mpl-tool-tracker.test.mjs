import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-tool-tracker.mjs');

describe('mpl-tool-tracker hook', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-tracker-'));
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.mpl', 'state.json'),
      JSON.stringify({ current_phase: 'phase2-sprint' }),
    );
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function runHook(toolName, toolInput = {}) {
    const stdin = JSON.stringify({
      cwd: tmpDir,
      tool_name: toolName,
      tool_input: toolInput,
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    return JSON.parse(out);
  }

  function readState() {
    return JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
  }

  it('writes last_tool_at on Bash invocation', () => {
    const before = Date.now();
    const r = runHook('Bash', { command: 'ls' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
    const state = readState();
    assert.ok(state.last_tool_at, 'last_tool_at should be set');
    const ts = Date.parse(state.last_tool_at);
    assert.ok(!Number.isNaN(ts), 'last_tool_at should be valid ISO-8601');
    assert.ok(ts >= before, 'last_tool_at should be >= before');
    assert.ok(ts <= Date.now() + 1000, 'last_tool_at should be <= now');
  });

  it('writes last_tool_at on Edit invocation', () => {
    runHook('Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' });
    assert.ok(readState().last_tool_at);
  });

  it('writes last_tool_at on Read / Glob / TodoWrite (broad coverage)', () => {
    runHook('Read', { file_path: '/tmp/x' });
    const ts1 = readState().last_tool_at;
    assert.ok(ts1);

    // Tiny delay to ensure timestamp difference if hook writes again
    runHook('Glob', { pattern: '*.ts' });
    const ts2 = readState().last_tool_at;
    assert.ok(ts2);
    assert.ok(Date.parse(ts2) >= Date.parse(ts1));

    runHook('TodoWrite', { todos: [] });
    assert.ok(readState().last_tool_at);
  });

  it('preserves other state fields (shallow merge)', () => {
    writeFileSync(
      join(tmpDir, '.mpl', 'state.json'),
      JSON.stringify({
        current_phase: 'phase3-gate',
        fix_loop_count: 2,
        gate_results: { hard1_passed: true },
      }),
    );
    runHook('Bash', { command: 'ls' });
    const state = readState();
    assert.strictEqual(state.current_phase, 'phase3-gate');
    assert.strictEqual(state.fix_loop_count, 2);
    assert.deepStrictEqual(state.gate_results, { hard1_passed: true });
    assert.ok(state.last_tool_at);
  });

  it('MPL not active → silent, state untouched', () => {
    rmSync(join(tmpDir, '.mpl'), { recursive: true });
    const r = runHook('Bash', { command: 'ls' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
    assert.strictEqual(existsSync(join(tmpDir, '.mpl')), false);
  });

  it('malformed stdin → silent (no crash)', () => {
    const out = execFileSync('node', [HOOK_PATH], {
      input: '{ this is not json',
      encoding: 'utf-8',
    });
    const r = JSON.parse(out);
    assert.strictEqual(r.continue, true);
  });
});
