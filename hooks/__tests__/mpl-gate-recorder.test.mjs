import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-gate-recorder.mjs');

function seedState(dir, extra = {}) {
  mkdirSync(join(dir, '.mpl'), { recursive: true });
  writeFileSync(join(dir, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'phase2-sprint',
    test_agent_dispatched: {},
    ...extra,
  }, null, 2));
}

function readState(dir) {
  return JSON.parse(readFileSync(join(dir, '.mpl', 'state.json'), 'utf-8'));
}

function runHook(dir, toolResponse) {
  const input = {
    cwd: dir,
    tool_name: 'Task',
    tool_input: {
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1 from the contract.',
    },
    tool_response: toolResponse,
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

function responseJson(overrides = {}) {
  return `\`\`\`json
{
  "phase_id": "phase-1",
  "test_files_created": ["tests/phase-1.test.ts"],
  "test_results": { "total": 2, "passed": 2, "failed": 0, "skipped": 0, "pass_rate": 100 },
  "commands_run": [{ "command": "npm test -- tests/phase-1.test.ts", "exit_code": 0 }],
  "a_item_coverage": [{ "id": "A-1", "test": "contract", "status": "PASS", "evidence": "ok" }],
  "s_item_coverage": [{ "id": "S-1", "test": "scenario", "status": "PASS", "evidence": "ok" }],
  "bugs_found": [],
  "coverage_info": {},
  "verdict": "PASS"
}
\`\`\``.replace('"verdict": "PASS"', `"verdict": "${overrides.verdict || 'PASS'}"`)
    .replace('"failed": 0', `"failed": ${overrides.failed ?? 0}`)
    .replace('"exit_code": 0', `"exit_code": ${overrides.exit_code ?? 0}`);
}

describe('mpl-gate-recorder test-agent evidence', () => {
  it('records structured PASS evidence from mpl-test-agent JSON output', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-'));
    try {
      seedState(tmp);
      const r = runHook(tmp, responseJson());
      assert.equal(r.continue, true);
      const state = readState(tmp);
      const ev = state.test_agent_dispatched['phase-1'];
      assert.equal(ev.valid_json, true);
      assert.equal(ev.verdict, 'PASS');
      assert.deepEqual(ev.command_exit_codes, [0]);
      assert.equal(ev.tests_total, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps blocked_hook when test-agent evidence is not PASS', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-fail-'));
    try {
      seedState(tmp, {
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        block_reason: 'missing test-agent',
        resume_instruction: 'Dispatch mpl-test-agent for phase-1',
        blocked_at: '2026-05-18T00:00:00Z',
      });
      runHook(tmp, responseJson({ failed: 1, verdict: 'FAIL' }));
      const state = readState(tmp);
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.test_agent_dispatched['phase-1'].verdict, 'FAIL');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('clears matching blocked_hook once PASS evidence is recorded', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-clear-'));
    try {
      seedState(tmp, {
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        block_reason: 'missing test-agent',
        resume_instruction: 'Dispatch mpl-test-agent for phase-1',
        blocked_at: '2026-05-18T00:00:00Z',
      });
      runHook(tmp, responseJson());
      const state = readState(tmp);
      assert.equal(state.session_status, null);
      assert.equal(state.blocked_by_hook, null);
      assert.equal(state.blocked_phase, null);
      assert.equal(state.block_reason, null);
      assert.equal(state.resume_instruction, null);
      assert.equal(state.blocked_at, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
