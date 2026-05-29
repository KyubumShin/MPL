// #236 — write-guard tightening for protected paths.
// A1: orchestrator MUST NOT Write/Edit `.mpl/mpl/decomposition.yaml`
// (only the mpl-decomposer subagent may, gated by a state dispatch
// flag with TTL).
// A3: Bash `rm -rf` against any of the mpl-cancel SKILL-listed
// protected paths is hard-blocked regardless of the safe-cleanup
// allowlist; override via env `MPL_FORCE_PURGE=1`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOKS_DIR = dirname(__dirname);
const WRITE_GUARD = join(HOOKS_DIR, 'mpl-write-guard.mjs');

function freshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-236-'));
  mkdirSync(join(dir, '.mpl'), { recursive: true });
  mkdirSync(join(dir, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(
    join(dir, '.mpl', 'state.json'),
    JSON.stringify({ current_phase: 'phase-1' }, null, 2),
  );
  return dir;
}

function runHook(cwd, payload, env = {}) {
  const out = execFileSync('node', [WRITE_GUARD], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return JSON.parse(out.trim());
}

function readState(cwd) {
  return JSON.parse(readFileSync(join(cwd, '.mpl', 'state.json'), 'utf-8'));
}

// ---------- #236 A1: decomposition.yaml writer-identity ----------

test('#236 A1: orchestrator direct Write of decomposition.yaml is blocked + envelope', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: {
        file_path: '.mpl/mpl/decomposition.yaml',
        content: 'phases: []\ngenerated_by: mpl-decomposer\n',
      },
    });
    assert.equal(decision.continue, false);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /#236 A1/);
    assert.match(decision.reason, /mpl-decomposer/);

    const state = readState(cwd);
    assert.equal(state.session_status, 'blocked_hook');
    assert.equal(state.blocked_by_hook, 'mpl-write-guard');
    assert.equal(state.block_code, 'decomposition_writer_violation');
    assert.equal(state.blocked_artifact, '.mpl/mpl/decomposition.yaml');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1: orchestrator direct Edit of decomposition.yaml is blocked', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Edit',
      tool_input: {
        file_path: '.mpl/mpl/decomposition.yaml',
        old_string: 'phases: []',
        new_string: 'phases: [{id: phase-1}]',
      },
    });
    assert.equal(decision.continue, false);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /decomposition\.yaml/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1: Write of decomposition.yaml after mpl-decomposer dispatch is allowed', () => {
  const cwd = freshWorkspace();
  try {
    // Step 1: orchestrator dispatches Agent(subagent_type='mpl-decomposer').
    // Write-guard records state.decomposer_dispatch.
    const dispatchDecision = runHook(cwd, {
      cwd,
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'mpl-decomposer',
        prompt: 'Decompose ...',
      },
    });
    assert.equal(dispatchDecision.continue, true);
    const dispatchState = readState(cwd);
    assert.ok(dispatchState.decomposer_dispatch, 'expected decomposer_dispatch flag');
    assert.equal(typeof dispatchState.decomposer_dispatch.dispatched_at, 'string');

    // Step 2: subagent writes decomposition.yaml — allowed.
    const writeDecision = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: {
        file_path: '.mpl/mpl/decomposition.yaml',
        content: 'phases: []\ngenerated_by: mpl-decomposer\n',
      },
    });
    assert.equal(writeDecision.continue, true);
    assert.equal(writeDecision.suppressOutput, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1: stale decomposer_dispatch beyond TTL is treated as inactive', () => {
  const cwd = freshWorkspace();
  try {
    // Plant a stale dispatch flag — 31 minutes in the past.
    const stalePast = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeFileSync(
      join(cwd, '.mpl', 'state.json'),
      JSON.stringify(
        { current_phase: 'phase-1', decomposer_dispatch: { dispatched_at: stalePast } },
        null,
        2,
      ),
    );
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml', content: 'x' },
    });
    assert.equal(decision.decision, 'block', 'stale dispatch must not unlock the write');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1: writer-identity check does NOT apply to non-decomposition paths', () => {
  const cwd = freshWorkspace();
  try {
    // .mpl/goal-contract.yaml is allowed for orchestrator.
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: '.mpl/goal-contract.yaml', content: 'goal: ...' },
    });
    assert.equal(decision.continue, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- #236 A3: protected-path delete ----------

test('#236 A3: `rm -rf .mpl/mpl/...` is blocked + envelope', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf .mpl/mpl/phases/phase-1' },
    });
    assert.equal(decision.continue, false);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /#236 A3/);
    assert.match(decision.reason, /MPL_FORCE_PURGE/);

    const state = readState(cwd);
    assert.equal(state.block_code, 'protected_path_delete');
    assert.equal(state.blocked_artifact, '.mpl/mpl');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3: `rm -rf .mpl/contracts`, `.mpl/memory`, `docs/learnings` all blocked', () => {
  const cwd = freshWorkspace();
  try {
    for (const target of ['.mpl/contracts', '.mpl/memory', 'docs/learnings']) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command: `rm -rf ${target}` },
      });
      assert.equal(decision.decision, 'block', `expected ${target} to be blocked`);
      assert.equal(JSON.parse(decision.reason ? '{"target": "' + readState(cwd).blocked_artifact + '"}' : '{}').target, target);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3: MPL_FORCE_PURGE=1 override allows the protected-path delete', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(
      cwd,
      {
        cwd,
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf .mpl/mpl/phases/phase-1' },
      },
      { MPL_FORCE_PURGE: '1' },
    );
    // Not blocked by protected-path check. May still trip the
    // dangerous-bash warning (which is non-blocking).
    assert.equal(decision.continue, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3: `sudo rm -rf .mpl/mpl/...` (wrapped) is still blocked', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'sudo rm -rf .mpl/mpl' },
    });
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /#236 A3/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3: rm targeting a NON-protected `.mpl` sibling (e.g. .mpl/signals) still passes the protected-path check', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf .mpl/signals' },
    });
    // May still emit the dangerous-bash warning (no longer in
    // safe-cleanup allowlist) but it is NOT a protected-path block.
    assert.notEqual(decision.decision, 'block');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3: rm targeting node_modules (safe-cleanup) still passes silently', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf ./node_modules' },
    });
    assert.equal(decision.continue, true);
    assert.equal(decision.suppressOutput, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3: `find docs/learnings -type f -delete` is blocked', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'find docs/learnings -type f -delete' },
    });
    assert.equal(decision.decision, 'block');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
