/**
 * Move #16 — engine front-door integration test.
 *
 * Verifies the route_to_phase resolution chain + fail-closed deny work
 * when wired through mpl-engine.mjs end-to-end. Covers:
 *   - resolver returns a context when state.running has a matching cwd
 *   - resolver falls through to legacy current_phase otherwise
 *   - fail-closed: state.running[].length > 0 AND legacy fallback hits
 *     on a write tool AND PreToolUse → deny envelope
 *   - read-only tool with the same unresolved condition passes through
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const ENGINE_PATH = join(dirname(__filename), '..', 'mpl-engine.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-engine-fd-'));
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeState(state) {
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify(state, null, 2));
}

function runEngine(eventPayload, env = {}) {
  return execFileSync('node', [ENGINE_PATH], {
    input: JSON.stringify(eventPayload),
    encoding: 'utf-8',
    env: { ...process.env, ...env, MPL_DISABLE_MODULES: 'permit.auto-permit,source-edit,permit.bash-timeout,permit.permit-learner,permit.fallback-grep,gates.finalize,gates.quality,gates.ambiguity,gates.phase-transition,contracts.pre,contracts.post,channel-registry.pre,channel-registry.post,schemas.pivot-points,schemas.agent-output,schemas.seed,signals.s0,signals.s1,signals.s3,signals.pp-file,signals.soft-signal-emit,signals.gate-recorder,signals.discovery-scanner,signals.keyword-detector,trackers.tool-tracker,trackers.context-monitor,trackers.compaction-tracker,session.init' },
  });
}

describe('mpl-engine Move #16 front-door', () => {
  it('fail-closed deny when state.running is non-empty AND resolution falls back to current_phase on a write tool', () => {
    writeState({
      schema_version: 7,
      current_phase: 'phase-3',
      started_at: '2026-06-01T00:00:00Z',
      running: [
        { phase_id: 'phase-3', worktree_root: '/tmp/other-slot', slot_id: 0, execution_context_id: 'abc' },
      ],
    });
    const stdout = runEngine({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/random-unrelated.ts' },
      cwd: tmp, // cwd is the workspace root, NOT inside any worktree
    });
    const env = JSON.parse(stdout);
    assert.equal(env.continue, false);
    assert.equal(env.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(env.hookSpecificOutput?.permissionDecisionReason || '', /execution_context_unresolved/);
  });

  it('passes through Read (read-only tool) under the same unresolved condition', () => {
    writeState({
      schema_version: 7,
      current_phase: 'phase-3',
      started_at: '2026-06-01T00:00:00Z',
      running: [{ phase_id: 'phase-3', worktree_root: '/tmp/other-slot', slot_id: 0 }],
    });
    const stdout = runEngine({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/random.ts' },
      cwd: tmp,
    });
    const env = JSON.parse(stdout);
    assert.equal(env.continue, true);
  });

  it('passes through when MPL_PHASE_ID env var anchors the route', () => {
    writeState({
      schema_version: 7,
      current_phase: 'phase-3',
      running: [{ phase_id: 'phase-3', worktree_root: '/tmp/slot', slot_id: 0 }],
    });
    const stdout = runEngine({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.ts' },
      cwd: tmp,
    }, { MPL_PHASE_ID: 'phase-3' });
    const env = JSON.parse(stdout);
    assert.equal(env.continue, true);
  });

  it('legacy mode (state.running empty) does not trigger fail-closed deny', () => {
    writeState({
      schema_version: 7,
      current_phase: 'phase-3',
      running: [],
    });
    const stdout = runEngine({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.ts' },
      cwd: tmp,
    });
    const env = JSON.parse(stdout);
    assert.equal(env.continue, true);
  });

  it('fail-closed only applies on PreToolUse — PostToolUse passes through', () => {
    writeState({
      schema_version: 7,
      current_phase: 'phase-3',
      running: [{ phase_id: 'phase-3', worktree_root: '/tmp/other-slot', slot_id: 0 }],
    });
    const stdout = runEngine({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.ts' },
      cwd: tmp,
    });
    const env = JSON.parse(stdout);
    assert.equal(env.continue, true);
  });
});
