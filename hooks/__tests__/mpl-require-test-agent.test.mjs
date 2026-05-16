import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-test-agent.mjs');

describe('mpl-require-test-agent hook integration', () => {
  it('returns a real block decision when required test-agent evidence is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-test-agent-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        test_agent_dispatched: {},
      }));
      writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-1
    test_agent_required: true
    test_agent_rationale: "touches a boundary"
`);

      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Run phase-1 and report completion.',
        },
        tool_response: 'phase complete',
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, false);
      assert.equal(r.decision, 'block');
      assert.match(r.reason, /mpl-test-agent was not dispatched/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
