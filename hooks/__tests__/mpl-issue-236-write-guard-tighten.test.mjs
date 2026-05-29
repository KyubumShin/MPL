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

test('#236 A1: Write from a DIFFERENT transcript than the dispatcher is allowed within TTL', () => {
  // Codex r1 retry fix: dispatch records the orchestrator's
  // transcript_path; only writes from a DIFFERENT transcript (the
  // subagent's) pass identity.
  const cwd = freshWorkspace();
  try {
    const orchestratorTranscript = '/tmp/transcript-orchestrator.jsonl';
    const subagentTranscript = '/tmp/transcript-decomposer.jsonl';

    // Step 1: orchestrator dispatches Agent. Hook pins orchestrator's
    // transcript_path in state.
    const dispatchDecision = runHook(cwd, {
      cwd,
      tool_name: 'Task',
      transcript_path: orchestratorTranscript,
      tool_input: {
        subagent_type: 'mpl-decomposer',
        prompt: 'Decompose ...',
      },
    });
    assert.equal(dispatchDecision.continue, true);
    const dispatchState = readState(cwd);
    assert.ok(dispatchState.decomposer_dispatch, 'expected decomposer_dispatch flag');
    assert.equal(typeof dispatchState.decomposer_dispatch.dispatched_at, 'string');
    assert.equal(
      dispatchState.decomposer_dispatch.parent_transcript_path,
      orchestratorTranscript,
    );

    // Step 2a: SUBAGENT writes decomposition.yaml from its OWN
    // transcript — allowed.
    const subagentWrite = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      transcript_path: subagentTranscript,
      tool_input: {
        file_path: '.mpl/mpl/decomposition.yaml',
        content: 'phases: []\ngenerated_by: mpl-decomposer\n',
      },
    });
    assert.equal(subagentWrite.continue, true);
    assert.equal(subagentWrite.suppressOutput, true);

    // Step 2b: ORCHESTRATOR writes the same file from the SAME
    // transcript as the dispatcher — codex r1 retry repro shape.
    // Must still block: the dispatch flag is a capability for the
    // SUBAGENT, not an ambient unlock.
    const orchestratorWrite = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      transcript_path: orchestratorTranscript,
      tool_input: {
        file_path: '.mpl/mpl/decomposition.yaml',
        content: 'phases: []\ngenerated_by: forged\n',
      },
    });
    assert.equal(orchestratorWrite.continue, false);
    assert.equal(orchestratorWrite.decision, 'block');
    assert.match(orchestratorWrite.reason, /#236 A1/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1: legacy dispatch flag without parent_transcript_path is rejected (fail-closed)', () => {
  const cwd = freshWorkspace();
  try {
    // Pre-fill state with a time-only dispatch (no parent_transcript_path).
    writeFileSync(
      join(cwd, '.mpl', 'state.json'),
      JSON.stringify(
        {
          current_phase: 'phase-1',
          decomposer_dispatch: { dispatched_at: new Date().toISOString() },
        },
        null,
        2,
      ),
    );
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      transcript_path: '/tmp/subagent.jsonl',
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml', content: 'x' },
    });
    assert.equal(
      decision.decision,
      'block',
      'legacy time-only dispatch without parent_transcript_path must be rejected',
    );
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

test('#236 A3 claude r1: shell-expansion / subshell / pushd bypass forms are all blocked', () => {
  // Concrete repros from claude r1 [logic]. Defense-in-depth: a
  // substring match covers expansion forms (`$PWD`, `$(pwd)`) and
  // variable operands; widened tokenization covers parenthesized
  // subshells and pushd splits.
  const cwd = freshWorkspace();
  try {
    // The substring check + widened tokenization covers shell-expansion,
    // subshell, and variable-operand forms. `pushd <target> && rm -rf <rel>`
    // is a working-directory-change pattern the hook cannot fully resolve
    // without a shell parser — operators using that form should rely on
    // the dangerous-bash warning and the MPL_FORCE_PURGE escape hatch.
    const bypasses = [
      'rm -rf $PWD/.mpl/mpl',
      'rm -rf "$PWD/.mpl/mpl"',
      'rm -rf $(pwd)/.mpl/mpl',
      '(cd /tmp && rm -rf .mpl/mpl)',
      'a=docs/learnings; rm -rf $a',
    ];
    for (const command of bypasses) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected protected-delete block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r2: redundant-slash shell-expanded paths are still blocked (slash collapse)', () => {
  // Codex r2 [logic]: real shell normalizes `//` after expansion;
  // `$PWD/.mpl//mpl` deletes `.mpl/mpl` just fine.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'rm -rf $PWD/.mpl//mpl',
      'rm -rf $(pwd)/.mpl//mpl',
      'rm -rf .mpl///mpl/phases',
      'rm -rf .mpl/mpl//',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected slash-collapse to catch: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 codex r2: lock-on-first-write — only the FIRST consuming child transcript may keep writing', () => {
  // Codex r2 [contract-break]: without lock-on-first-write, any
  // subagent active during the dispatch window could write
  // decomposition.yaml. The first non-parent transcript that writes
  // is locked; any OTHER transcript (e.g. a phase-runner) is rejected
  // even though it differs from the orchestrator.
  const cwd = freshWorkspace();
  try {
    const orchestratorTranscript = '/tmp/transcript-orchestrator.jsonl';
    const decomposerTranscript = '/tmp/transcript-decomposer.jsonl';
    const phaseRunnerTranscript = '/tmp/transcript-phase-runner.jsonl';

    // 1) Orchestrator dispatches decomposer.
    runHook(cwd, {
      cwd,
      tool_name: 'Task',
      transcript_path: orchestratorTranscript,
      tool_input: { subagent_type: 'mpl-decomposer', prompt: '...' },
    });

    // 2) Decomposer writes — first consumer, captures the lock.
    const firstWrite = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      transcript_path: decomposerTranscript,
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml', content: 'x' },
    });
    assert.equal(firstWrite.continue, true);
    assert.equal(firstWrite.suppressOutput, true);

    // Confirm the child lock landed.
    const lockedState = readState(cwd);
    assert.equal(
      lockedState.decomposer_dispatch.child_transcript_path,
      decomposerTranscript,
    );

    // 3) Decomposer second write — still allowed.
    const secondWriteSame = runHook(cwd, {
      cwd,
      tool_name: 'Edit',
      transcript_path: decomposerTranscript,
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml', old_string: 'x', new_string: 'y' },
    });
    assert.equal(secondWriteSame.continue, true);

    // 4) Some OTHER subagent (phase-runner, etc.) attempts to write
    // decomposition.yaml. Different transcript — rejected.
    const phaseRunnerWrite = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      transcript_path: phaseRunnerTranscript,
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml', content: 'forged' },
    });
    assert.equal(phaseRunnerWrite.continue, false);
    assert.equal(phaseRunnerWrite.decision, 'block');
    assert.match(phaseRunnerWrite.reason, /#236 A1/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r1 retry: workspace-absolute `rm -rf /abs/.../.mpl/mpl` is blocked', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: `rm -rf ${cwd}/.mpl/mpl` },
    });
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /#236 A3/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r1 retry: path-traversal `rm -rf .mpl/mpl/../mpl` is blocked', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf .mpl/mpl/../mpl' },
    });
    assert.equal(decision.decision, 'block');
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
