import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

  it('does not mutate state.json (no migration, no archive) when tracing a legacy or unversioned state', () => {
    // Codex r1 on PR #216: readState() persists schema migrations and can
    // archive .mpl/mpl/state.json — a diagnostic command must never do that.
    // Use a pre-v6 state with no schema_version to exercise the migration
    // path, then assert the on-disk bytes are unchanged after tracing.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-readonly-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      const stateBefore = JSON.stringify({
        // intentionally no schema_version — would trigger v1→v2 migration
        current_phase: 'mpl-decompose',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-goal-trace',
        blocked_artifact: '.mpl/mpl/decomposition.yaml',
      });
      writeFileSync(join(tmp, '.mpl', 'state.json'), stateBefore);
      const legacyPath = join(tmp, '.mpl', 'mpl', 'state.json');
      writeFileSync(legacyPath, '{"legacy":true}');

      const trace = traceHookChain({
        targetPath: '.mpl/mpl/decomposition.yaml',
        cwd: tmp,
      });
      // The legacy blocked state should still surface via the raw read.
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-require-goal-trace');
      assert.equal(row.status, 'currently_blocking');

      // Critical: on-disk state files must be unchanged.
      const stateAfter = readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8');
      assert.equal(stateAfter, stateBefore, 'state.json must not be rewritten by tracing');
      assert.ok(existsSync(legacyPath), 'legacy .mpl/mpl/state.json must not be archived/removed by tracing');
      assert.equal(readFileSync(legacyPath, 'utf-8'), '{"legacy":true}',
        'legacy state.json content must be byte-for-byte unchanged');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
