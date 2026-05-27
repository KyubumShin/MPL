import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { formatHookTrace, traceHookChain } from '../lib/mpl-hook-trace.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

describe('mpl-hook-trace', () => {
  it('lists the decomposition hook chain without manual grep', () => {
    const trace = traceHookChain({
      targetPath: '.mpl/mpl/decomposition.yaml',
      cwd: process.cwd(),
    });
    const ids = trace.hooks.map((h) => h.hook_id);
    for (const expected of [
      'mpl-require-goal-trace',
      'mpl-baseline-guard',
      'mpl-artifact-schema',
      'mpl-discovery-scanner',
      'mpl-require-chain-assignment',
      'mpl-phase-controller',
      'mpl-require-test-agent',
    ]) {
      assert.ok(ids.includes(expected), `missing ${expected}`);
    }
    assert.match(formatHookTrace(trace), /MPL Hook Trace/);
    assert.match(formatHookTrace(trace), /registered/);
  });

  it('marks the active blocked_hook as currently_blocking', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'mpl-decompose',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-goal-trace',
        blocked_artifact: '.mpl/mpl/decomposition.yaml',
      }));
      const trace = traceHookChain({
        targetPath: '.mpl/mpl/decomposition.yaml',
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-require-goal-trace');
      assert.equal(row.status, 'currently_blocking');
      assert.match(formatHookTrace(trace), /BLOCKING/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
