import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-baseline-guard.mjs');

describe('mpl-baseline-guard hook integration', () => {
  it('denies MultiEdit rewrites of an existing baseline without renewal sentinel', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-baseline-guard-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase1-decompose',
      }));
      writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), 'pipeline_id: old\n');

      const input = {
        cwd: tmp,
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: '.mpl/mpl/baseline.yaml',
          edits: [{ old_string: 'old', new_string: 'new' }],
        },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny');
      assert.match(r.hookSpecificOutput?.permissionDecisionReason || '', /Baseline Guard/);
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.blocked_by_hook, 'mpl-baseline-guard');
      assert.equal(state.blocked_artifact, '.mpl/mpl/baseline.yaml');
      assert.equal(state.block_code, 'baseline_immutable');
      assert.equal(state.retry_context.renewal_flag, '.mpl/mpl/.baseline-renewal');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
