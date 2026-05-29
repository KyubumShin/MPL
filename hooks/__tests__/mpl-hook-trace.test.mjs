import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { findPurposeGaps, formatHookTrace, traceHookChain } from '../lib/mpl-hook-trace.mjs';
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
        blocked_phase: 'mpl-decompose',
        blocked_artifact: '.mpl/mpl/decomposition.yaml',
        block_code: 'goal_trace_drift',
        block_reason: 'goal_contract_hash drift detected',
        resume_instruction: 'Refresh the goal contract hash and retry.',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { hook: 'mpl-require-goal-trace' },
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

  it('surfaces incomplete blocked_hook envelopes as invalid instead of currently_blocking', () => {
    // Codex r2/r3 on PR #216: any stale/zombie state missing a required
    // companion field (artifact, block_code, retry_context, etc.) must
    // not be reported as actively blocking — that would send the operator
    // toward editing the wrong artifact and hide the real state-invariant
    // failure. Validation reuses the BLOCKED_HOOK_STALE invariant.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-invalid-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'mpl-decompose',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-goal-trace',
        // blocked_artifact + block_code + retry_context all intentionally absent
      }));
      const trace = traceHookChain({
        targetPath: '.mpl/mpl/decomposition.yaml',
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-require-goal-trace');
      assert.equal(row.status, 'invalid_blocked_envelope');
      assert.match(formatHookTrace(trace), /INVALID_BLOCKED_ENVELOPE/);
      assert.doesNotMatch(formatHookTrace(trace), /\[BLOCKING\]/,
        'must not surface an incomplete envelope as actively blocking');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('surfaces a blocked_hook missing block_code/retry_context as invalid (matches BLOCKED_HOOK_STALE invariant)', () => {
    // Codex r3 on PR #216: blocked_artifact alone is not enough.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-partial-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'mpl-decompose',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-goal-trace',
        blocked_artifact: '.mpl/mpl/decomposition.yaml',
        // block_code, block_reason, resume_instruction, blocked_at, retry_context all absent
      }));
      const trace = traceHookChain({
        targetPath: '.mpl/mpl/decomposition.yaml',
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-require-goal-trace');
      assert.equal(row.status, 'invalid_blocked_envelope');
      assert.doesNotMatch(formatHookTrace(trace), /\[BLOCKING\]/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('surfaces a stale/invalid block on a non-decomposition path as invalid_blocked_envelope (does not silently filter)', () => {
    // Codex r5 on PR #216: a stale envelope (missing retry_context etc.)
    // pointing at state.test_agent_dispatched.<phase> would otherwise be
    // filtered out by the category check and disappear from the trace.
    // The offending hook id is still meaningful to the operator and must
    // appear, just with an invalid_blocked_envelope status.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-stale-task-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_artifact: 'state.test_agent_dispatched.phase-1',
        // retry_context, block_code, blocked_at intentionally absent
      }));
      const trace = traceHookChain({
        targetPath: 'state.test_agent_dispatched.phase-1',
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-require-test-agent');
      assert.ok(row, 'mpl-require-test-agent must appear even with a stale envelope');
      assert.equal(row.status, 'invalid_blocked_envelope');
      assert.match(formatHookTrace(trace), /INVALID_BLOCKED_ENVELOPE/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#217: blocked_artifact missing entirely — active blocker still surfaces on an unrelated target', () => {
    // Codex r8 on PR #216 / #217: prior versions required activeBlockArtifact
    // to non-empty AND endsWith()-match the target before force-include.
    // A stale envelope with NO blocked_artifact at all (corrupt state.json
    // from an aborted hook) plus a target like
    // `state.test_agent_dispatched.<phase>` would silently filter out
    // the active blocker via the category check. The diagnostic showed
    // a clean trace while the run was paused.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-217-noartifact-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        // blocked_artifact intentionally absent
      }));
      const trace = traceHookChain({
        targetPath: 'state.test_agent_dispatched.phase-1',
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-require-test-agent');
      assert.ok(row, 'mpl-require-test-agent must appear even with no blocked_artifact');
      assert.equal(row.status, 'invalid_blocked_envelope');
      assert.match(formatHookTrace(trace), /INVALID_BLOCKED_ENVELOPE/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#217: synthetic row when active blocker not in hooks.json AND envelope missing artifact', () => {
    // The synthetic-row path also dropped the artifact-match precondition.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-217-synthetic-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-imaginary-hook-not-registered',
        // blocked_artifact intentionally absent
      }));
      const trace = traceHookChain({
        targetPath: 'state.test_agent_dispatched.phase-1',
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-imaginary-hook-not-registered');
      assert.ok(row, 'synthetic row must surface even with no artifact');
      assert.equal(row.event, 'state');
      assert.equal(row.matcher, 'blocked_by_hook');
      assert.match(row.purpose, /registry skew/);
      assert.equal(row.status, 'invalid_blocked_envelope');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('always includes the blocked_by_hook entry for an active block, even when the path category would filter it out', () => {
    // Codex r4 on PR #216: a valid mpl-require-test-agent block records
    // blocked_artifact as `state.test_agent_dispatched.<phase>`, which the
    // path category considers a generic file. shouldIncludeHook then drops
    // the Task|Agent PostToolUse hook and BLOCKING is never surfaced.
    // When state has an active block matching the target, the offending
    // hook MUST appear in the trace regardless of filter.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-active-block-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        blocked_artifact: 'state.test_agent_dispatched.phase-1',
        block_code: 'missing_or_invalid_test_agent_evidence',
        block_reason: 'phase-1 has no valid test-agent dispatch evidence',
        resume_instruction: 'Dispatch mpl-test-agent for phase-1 and retry.',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { phase_id: 'phase-1' },
      }));
      const trace = traceHookChain({
        targetPath: 'state.test_agent_dispatched.phase-1',
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-require-test-agent');
      assert.ok(row, 'mpl-require-test-agent must be included when it is the active blocker');
      assert.equal(row.status, 'currently_blocking');
      assert.match(formatHookTrace(trace), /BLOCKING/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fail-closes on a future schema_version: no BLOCKING line, explicit unsupported_schema warning', () => {
    // Codex r6 on PR #216: a downgraded plugin must not classify a future
    // state.json envelope as actively blocking — that would point recovery
    // at the wrong artifact instead of surfacing the schema mismatch.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-future-schema-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION + 1,
        current_phase: 'mpl-decompose',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-goal-trace',
        blocked_phase: 'mpl-decompose',
        blocked_artifact: '.mpl/mpl/decomposition.yaml',
        block_code: 'goal_trace_drift',
        block_reason: 'goal_contract_hash drift detected',
        resume_instruction: 'Refresh the goal contract hash and retry.',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { hook: 'mpl-require-goal-trace' },
      }));
      const trace = traceHookChain({
        targetPath: '.mpl/mpl/decomposition.yaml',
        cwd: tmp,
      });
      assert.equal(trace.state_error?.error, 'unsupported_schema');
      assert.equal(trace.state_error.schemaVersion, CURRENT_SCHEMA_VERSION + 1);
      // The future envelope must not bleed into a BLOCKING marker.
      assert.doesNotMatch(formatHookTrace(trace), /\[BLOCKING\]/);
      assert.match(formatHookTrace(trace), /schema_version=\d+ is newer than the installed plugin supports/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fail-closes on malformed JSON: explicit unparseable warning, no block status', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-malformed-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), '{ this is not valid json');
      const trace = traceHookChain({
        targetPath: '.mpl/mpl/decomposition.yaml',
        cwd: tmp,
      });
      assert.equal(trace.state_error?.error, 'unparseable');
      assert.doesNotMatch(formatHookTrace(trace), /\[BLOCKING\]/);
      assert.match(formatHookTrace(trace), /not valid JSON/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits a synthetic row when the active blocked_by_hook is no longer in hooks.json (registry skew)', () => {
    // Codex r7 on PR #216: if the hook chain changed (rename, removal,
    // downgrade) and state.blocked_by_hook points at a hook id that no
    // longer exists in hooks.json, the iteration-based force-include
    // never runs. A synthetic row must still surface the active block.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-skew-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'mpl-decompose',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-removed-or-renamed-hook',
        blocked_phase: 'mpl-decompose',
        blocked_artifact: '.mpl/mpl/decomposition.yaml',
        block_code: 'unknown_block',
        block_reason: 'hook ran but is no longer registered',
        resume_instruction: 'Reinstall the expected plugin version, then retry.',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { stale_hook: true },
      }));
      const trace = traceHookChain({
        targetPath: '.mpl/mpl/decomposition.yaml',
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-removed-or-renamed-hook');
      assert.ok(row, 'synthetic row for unregistered active blocker must exist');
      assert.equal(row.status, 'currently_blocking');
      assert.match(row.purpose, /not registered in current hooks\.json/);
      assert.match(formatHookTrace(trace), /BLOCKING/);
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
        blocked_phase: 'mpl-decompose',
        blocked_artifact: '.mpl/mpl/decomposition.yaml',
        block_code: 'goal_trace_drift',
        block_reason: 'goal_contract_hash drift detected',
        resume_instruction: 'Refresh the goal contract hash and retry.',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { hook: 'mpl-require-goal-trace' },
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

  /* ──────────────────── #237 D1 / D2 / D3 ──────────────────── */

  it('#237 D1: every hook id registered in hooks.json has a PURPOSES entry', () => {
    const gaps = findPurposeGaps();
    assert.deepEqual(gaps, [], `PURPOSES missing entries for: ${gaps.join(', ')}`);
  });

  it('#237 D2: slash-boundary match — `state.json` does NOT match `state.test_agent_dispatched.phase-1.state.json`', () => {
    // Pre-D2: bidirectional endsWith treated artifact `state.json` and
    // target `barstate.json` as matching. Now requires `/` boundary.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-d2-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        blocked_artifact: 'state.json', // suffix-only, no path
        block_code: 'missing_or_invalid_test_agent_evidence',
        block_reason: 'block',
        resume_instruction: 'dispatch test-agent',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { phase_id: 'phase-1' },
      }));
      const trace = traceHookChain({
        targetPath: 'src/api/widgets.test.state.json', // shares suffix but different file
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-require-test-agent');
      // Without slash boundary, would falsely report currently_blocking.
      // With boundary, status is not currently_blocking for this target.
      if (row) {
        assert.notEqual(row.status, 'currently_blocking',
          'must NOT match a target that only shares a non-path-segment suffix');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#237 D2: slash-boundary match — `.mpl/state.json` artifact DOES match target `state.json`', () => {
    // Sanity check: legitimate suffix match (artifact = path-prefixed
    // target with `/` boundary) still works.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-d2-ok-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        blocked_artifact: '.mpl/state.json',
        block_code: 'missing_or_invalid_test_agent_evidence',
        block_reason: 'block',
        resume_instruction: 'dispatch test-agent',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { phase_id: 'phase-1' },
      }));
      const trace = traceHookChain({
        targetPath: '/tmp/some/path/.mpl/state.json',
        cwd: tmp,
      });
      const row = trace.hooks.find((h) => h.hook_id === 'mpl-require-test-agent');
      assert.equal(row.status, 'currently_blocking');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#237 D3: state-category trace omits hooks that do not read state', () => {
    // Pre-D3: trace on `.mpl/state.json` returned every Edit/Write
    // PreToolUse hook, including ones like mpl-require-e2e-authenticity
    // that don't read state — pure noise. Post-D3: only STATE_FOCUS
    // members appear (plus any active blocker, which is force-included).
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-d3-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
      }));
      const trace = traceHookChain({
        targetPath: '.mpl/state.json',
        cwd: tmp,
      });
      assert.equal(trace.category, 'state');
      const ids = trace.hooks.map((h) => h.hook_id);
      // Codex r1: pure file-write policy guards that don't read state
      // must NOT appear. mpl-write-guard / mpl-fallback-grep are
      // delegation / anti-pattern checks unrelated to state.
      assert.equal(ids.includes('mpl-write-guard'), false,
        'state trace should not surface mpl-write-guard');
      assert.equal(ids.includes('mpl-fallback-grep'), false,
        'state trace should not surface mpl-fallback-grep');
      // mpl-state-invariant SHOULD appear — it's the canonical state
      // reader.
      assert.equal(ids.includes('mpl-state-invariant'), true);
      // Codex r1: mpl-gate-recorder (PostToolUse on Bash|Task|Agent)
      // must appear in state traces — it reads / writes
      // state.gate_results. Without matcher-independent STATE_FOCUS
      // evaluation, it would be silently dropped.
      assert.equal(ids.includes('mpl-gate-recorder'), true,
        'mpl-gate-recorder must appear in state trace regardless of matcher');
      // Codex r1: mpl-require-e2e reads state.e2e_results before
      // blocking finalize_done=true. Must appear in state traces.
      assert.equal(ids.includes('mpl-require-e2e'), true,
        'mpl-require-e2e must appear in state trace');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#237 D3: non-state category trace still includes the broader set', () => {
    // Sanity check: tracing a code file path returns the full hook
    // chain (not the narrow state focus).
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-hook-trace-d3-non-state-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
      }));
      const trace = traceHookChain({
        targetPath: 'src/api/widgets.ts',
        cwd: tmp,
      });
      assert.equal(trace.category, 'file');
      const ids = trace.hooks.map((h) => h.hook_id);
      // file-category should include the broader set of file-write
      // PreToolUse hooks.
      assert.equal(ids.includes('mpl-require-e2e-authenticity'), true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
