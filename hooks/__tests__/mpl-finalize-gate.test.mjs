import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';
import {
  isFinalizeDoneWrite,
  summarizeFailures,
  summarizeAdvisories,
  DELEGATES,
  HOOK_ID,
} from '../mpl-finalize-gate.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-finalize-gate.mjs');
const SCHEMA_V = CURRENT_SCHEMA_VERSION;

const TEST_PIPELINE_ID = 'mpl-test-257';
const TEST_STARTED_AT = '2026-05-30T00:00:00.000Z';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-finalize-gate-'));
  mkdirSync(join(tmp, '.mpl', 'mpl', 'profile'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: SCHEMA_V,
    current_phase: 'phase5-finalize',
    pipeline_id: TEST_PIPELINE_ID,
    started_at: TEST_STARTED_AT,
    phase_scheduler_history: [],
  }));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function goalContract({
  realRuntimeRequired = true,
  securityRequired = false,
} = {}) {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Finalize gate coalesced reporting"
  project_pivot: "single envelope"
  must_ship_outcomes:
    - "usable app"
ontology:
  entities:
    - app
variation_axes:
  - id: AX-1
acceptance_criteria:
  - id: AC-1
e2e_policy:
  real_runtime_required: ${realRuntimeRequired ? 'true' : 'false'}
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: ${securityRequired ? 'true' : 'false'}
completion_evidence:
  required_artifacts:
    - .mpl/mpl/RUNBOOK.md
    - .mpl/mpl/profile/run-summary.json
    - .mpl/mpl/audit-report.json
  require_commit: false
  require_finalize_timestamps: true
`;
}

function finalizeWriteInput(cwd, { toolName = 'Write' } = {}) {
  return {
    cwd,
    tool_name: toolName,
    tool_input: {
      file_path: '.mpl/state.json',
      content: JSON.stringify({ current_phase: 'phase5-finalize', finalize_done: true }),
    },
  };
}

function runGate(input) {
  // Capture every line the gate emits and keep only valid JSON lines so the
  // delegate-child JSON (also printed on the same stdout when the gate calls
  // recordBlockedHook via emitBlockedHook) doesn't confuse the parser.
  const stdout = execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  });
  const lines = stdout.trim().split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error(`No JSON in gate stdout:\n${stdout}`);
}

describe('isFinalizeDoneWrite', () => {
  it('matches Write to .mpl/state.json with finalize_done:true', () => {
    assert.equal(
      isFinalizeDoneWrite({
        file_path: '.mpl/state.json',
        content: '{"finalize_done": true}',
      }),
      true,
    );
  });
  it('ignores writes to other paths', () => {
    assert.equal(
      isFinalizeDoneWrite({
        file_path: '.mpl/state.txt',
        content: '{"finalize_done": true}',
      }),
      false,
    );
  });
  it('ignores writes without finalize_done:true', () => {
    assert.equal(
      isFinalizeDoneWrite({
        file_path: '.mpl/state.json',
        content: '{"finalize_done": false}',
      }),
      false,
    );
  });
  it('handles Edit new_string + MultiEdit edits[]', () => {
    assert.equal(
      isFinalizeDoneWrite({
        file_path: '.mpl/state.json',
        edits: [{ new_string: '"finalize_done": true' }],
      }),
      true,
    );
  });
});

describe('summarizeFailures', () => {
  it('produces a numbered, hookId-tagged summary', () => {
    const out = summarizeFailures([
      { hookId: 'mpl-require-e2e', code: 'e2e_required_scenarios_absent', reason: 'scenarios missing' },
      { hookId: 'mpl-require-whole-goal-closure', code: 'whole_goal_closure_missing', reason: 'AC-1 uncovered' },
    ]);
    assert.match(out, /2 validation failure/);
    assert.match(out, /\[mpl-require-e2e\] \(e2e_required_scenarios_absent\)/);
    assert.match(out, /\[mpl-require-whole-goal-closure\] \(whole_goal_closure_missing\)/);
  });
});

describe('summarizeAdvisories', () => {
  it('returns empty string for empty list', () => {
    assert.equal(summarizeAdvisories([]), '');
  });
  it('prefixes advisory section header', () => {
    const out = summarizeAdvisories([{ hookId: 'h', message: 'msg' }]);
    assert.match(out, /Advisories \(non-blocking\)/);
    assert.match(out, /\[h\] msg/);
  });
});

describe('delegate registration', () => {
  it('lists the four canonical finalize validators', () => {
    assert.deepEqual(DELEGATES.sort(), [
      'mpl-require-e2e-authenticity.mjs',
      'mpl-require-e2e.mjs',
      'mpl-require-finalize-artifacts.mjs',
      'mpl-require-whole-goal-closure.mjs',
    ]);
  });
});

describe('gate behavior — non-finalize writes pass through', () => {
  it('returns continue:true for non-state.json writes', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
    const r = runGate({
      cwd: tmp,
      tool_name: 'Write',
      tool_input: { file_path: 'README.md', content: 'hello' },
    });
    assert.equal(r.continue, true);
  });
  it('returns continue:true for state.json without finalize_done:true', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
    const r = runGate({
      cwd: tmp,
      tool_name: 'Write',
      tool_input: {
        file_path: '.mpl/state.json',
        content: JSON.stringify({ current_phase: 'phase2-sprint' }),
      },
    });
    assert.equal(r.continue, true);
  });
});

describe('gate behavior — coalesced multi-finding envelope', () => {
  it('aggregates multiple validator failures into one block envelope with failures[]', () => {
    // Under-provisioned setup: no e2e-scenarios.yaml, no completion_evidence
    // artifacts, no decomposition.yaml → e2e + finalize-artifacts + whole-goal-
    // closure all fail. Authenticity is gated on the goal contract's
    // real_runtime_required + missing e2e_results, so it may also flag.
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());

    const r = runGate(finalizeWriteInput(tmp));

    assert.equal(r.continue, false);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /\[MPL Finalize Gate\]/);
    assert.match(r.reason, /validation failure/);

    // The coalesced envelope persisted under retry_context.failures[].
    const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(state.session_status, 'blocked_hook');
    assert.equal(state.blocked_by_hook, HOOK_ID);
    assert.equal(state.block_code, 'finalize_gate_failures');
    assert.ok(Array.isArray(state.retry_context?.failures));
    assert.ok(state.retry_context.failures.length >= 2,
      `expected ≥2 batched failures, got ${state.retry_context.failures.length}: ${JSON.stringify(state.retry_context.failures.map(f => f.hookId))}`);

    // Each failure preserves its originating validator's hookId + code.
    for (const f of state.retry_context.failures) {
      assert.equal(typeof f.hookId, 'string');
      assert.equal(typeof f.code, 'string');
      assert.equal(typeof f.reason, 'string');
      assert.ok(f.hookId.startsWith('mpl-require-'),
        `expected delegate hookId, got ${f.hookId}`);
    }

    // The set of represented hooks must include at least two distinct delegates
    // (the whole point of coalescing — treadmill UX is replaced by batch UX).
    const distinctHooks = new Set(state.retry_context.failures.map((f) => f.hookId));
    assert.ok(distinctHooks.size >= 2,
      `expected ≥2 distinct delegates in failures[], got ${[...distinctHooks].join(',')}`);
  });

  it('does not leak per-child envelopes — only the gate envelope remains', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
    runGate(finalizeWriteInput(tmp));

    const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
    // Critical: the children each wrote their own envelope during delegation;
    // the gate must clear them and rewrite under HOOK_ID so the visible
    // envelope is the coalesced one (not whichever child happened to run last).
    assert.equal(state.blocked_by_hook, HOOK_ID);
    assert.notEqual(state.blocked_by_hook, 'mpl-require-whole-goal-closure');
    assert.notEqual(state.blocked_by_hook, 'mpl-require-finalize-artifacts');
  });
});

describe('gate behavior — recoverable via mpl-recover', () => {
  it('blocked envelope is routed by inspectRecovery as finalize_gate_failures handler', async () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
    runGate(finalizeWriteInput(tmp));

    const { inspectRecovery } = await import('../lib/mpl-recover.mjs');
    const plan = inspectRecovery(tmp);
    assert.equal(plan.handler, 'finalize_gate_failures');
    assert.equal(plan.status, 'requires_user_action');
    assert.ok(Array.isArray(plan.failures));
    assert.ok(plan.failures.length >= 2);
    assert.match(plan.message, /finalize gate batched/i);
  });
});
