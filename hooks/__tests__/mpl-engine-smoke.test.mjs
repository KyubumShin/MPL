/**
 * MPL Engine smoke test (Move #5).
 *
 * Proves the dispatcher is wired end-to-end without any policy modules:
 *   - hook spawns cleanly via `node hooks/mpl-engine.mjs`
 *   - inert PreToolUse event (registry empty, no .mpl/) emits a parseable
 *     `{continue: true}` envelope and exits 0
 *
 * No policy modules exist yet (Moves #6+), so this is the only assertion
 * the engine can support right now.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const ENGINE_PATH = join(dirname(__filename), '..', 'mpl-engine.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-engine-smoke-'));
  // No .mpl/ directory — MPL is inactive, dispatch registry is empty.
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function runEngine(eventPayload) {
  return execFileSync('node', [ENGINE_PATH], {
    input: JSON.stringify(eventPayload),
    encoding: 'utf-8',
  });
}

describe('mpl-engine smoke (Move #5: dormant dispatcher)', () => {
  it('PreToolUse with empty registry returns inert envelope and exits 0', () => {
    const stdout = runEngine({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x' },
      cwd: tmp,
    });
    const env = JSON.parse(stdout);
    assert.equal(env.continue, true, 'inert envelope should set continue:true');
  });

  it('snake_case + camelCase keys both parse without crashing', () => {
    const stdout = runEngine({
      hookEventName: 'PostToolUse',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/x' },
      directory: tmp,
    });
    const env = JSON.parse(stdout);
    assert.equal(env.continue, true);
  });

  it('malformed stdin fails open with a parseable envelope', () => {
    const stdout = execFileSync('node', [ENGINE_PATH], {
      input: 'not-json-at-all',
      encoding: 'utf-8',
    });
    const env = JSON.parse(stdout);
    assert.equal(env.continue, true);
  });
});
