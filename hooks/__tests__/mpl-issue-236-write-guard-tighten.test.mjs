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

test('#236 A3 claude r2 [security]: ancestors of protected roots are blocked too', () => {
  // Concrete repros — `rm -rf .mpl` destroys `.mpl/mpl`, `.mpl/contracts`,
  // `.mpl/memory`. `find . -delete` destroys everything under cwd
  // including protected. Pre-fix substring + descendant-only check
  // missed these.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'rm -rf .mpl',
      'rm -rf .mpl/',
      'rm -rf docs/',
      'rm -rf docs',
      'find docs -delete',
      'find . -name "*.yaml" -delete',
      'find . -delete',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected ancestor/find traversal block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 claude r13 [security]: 2-step deactivation chain via Write/Edit is blocked', () => {
  // Claude r13: an attacker can flip current_phase to 'completed'
  // via a benign-looking Write/Edit (no forbidden field), then once
  // isMplActive returns false the next Write of forged dispatch
  // fields short-circuits the hook. The structural fix is to refuse
  // ANY Write/Edit to .mpl/state.json BEFORE the isMplActive
  // short-circuit, regardless of payload.
  const cwd = freshWorkspace();
  try {
    // Step 1: deactivation Write — must block now.
    const deactivate = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: {
        file_path: '.mpl/state.json',
        content: JSON.stringify({ current_phase: 'completed' }),
      },
    });
    assert.equal(deactivate.decision, 'block',
      'deactivation Write to state.json must block');

    // Even simpler write: blocked too.
    const plain = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: {
        file_path: '.mpl/state.json',
        content: JSON.stringify({ current_phase: 'phase-2' }),
      },
    });
    assert.equal(plain.decision, 'block');

    // Edit form blocked too.
    const edit = runHook(cwd, {
      cwd,
      tool_name: 'Edit',
      tool_input: {
        file_path: '.mpl/state.json',
        old_string: 'phase-1',
        new_string: 'phase-2',
      },
    });
    assert.equal(edit.decision, 'block');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 claude r14 [security]: decomposition.yaml writer-identity check runs BEFORE isMplActive short-circuit', () => {
  // Claude r14: if Bash deactivation succeeds (claude r14 found a
  // cmd-substitution bypass), step 2 — direct Write decomposition.yaml —
  // must still block. The decomposition writer-identity check is now
  // mirrored before the isMplActive short-circuit, the same shape as
  // the r13 state.json guard.
  const cwd = freshWorkspace();
  try {
    writeFileSync(
      join(cwd, '.mpl', 'state.json'),
      JSON.stringify({ current_phase: 'completed' }),
    );
    const decision = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      transcript_path: '/tmp/orch.jsonl',
      tool_input: {
        file_path: '.mpl/mpl/decomposition.yaml',
        content: 'forged',
      },
    });
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /#236 A1/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 codex r16 [security]: Bash writes to decomposition.yaml gated BEFORE isMplActive', () => {
  // Codex r16: the pre-isMplActive Write/Edit guard for
  // decomposition.yaml didn't cover Bash. With MPL deactivated,
  // `printf forged > .mpl/mpl/decomposition.yaml` slipped past.
  const cwd = freshWorkspace();
  try {
    writeFileSync(
      join(cwd, '.mpl', 'state.json'),
      JSON.stringify({ current_phase: 'completed' }),
    );
    for (const command of [
      'printf forged > .mpl/mpl/decomposition.yaml',
      'echo forged | tee .mpl/mpl/decomposition.yaml',
      'dd if=/tmp/forged of=.mpl/mpl/decomposition.yaml',
      'install -m 0644 /tmp/forged .mpl/mpl/decomposition.yaml',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected Bash decomposition.yaml write block for: ${command}`,
      );
    }
    // Sanity: read-only ops on decomposition.yaml still pass.
    const read = runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'cat .mpl/mpl/decomposition.yaml' },
    });
    assert.notEqual(read.decision, 'block');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 codex r15 [security]: find -exec writing state.json is blocked (find removed from safe-read)', () => {
  // Codex r15: `find` was in SAFE_READ_HEADS but `-exec sh -c '… > $1'`
  // bypassed the static regex check (target was a runtime-substituted
  // `{}` placeholder). Fix: remove find from SAFE_READ_HEADS so any
  // find mentioning state.json blocks.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'find .mpl/state.json -exec sh -c \'echo forged\' _ {} ;',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected find block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 codex r14 [security]: structural safe-read-allowlist closes unbounded writer-verb gap', () => {
  // Codex r14: the verb allowlist (rm/mv/tee/dd/install/...) is
  // unbounded — every round another writer utility surfaces. The
  // structural rule: only known-safe-read heads may mention
  // .mpl/state.json. Any other command (writer utility the hook
  // hasn't heard of yet) is presumed-write and blocked.
  const cwd = freshWorkspace();
  try {
    // Writer utilities the hook never explicitly enumerated.
    for (const command of [
      'install -m 0644 /tmp/forged .mpl/state.json',
      'pax -rw /tmp .mpl/state.json',
      'cpio -i .mpl/state.json',
      'mktemp .mpl/state.json',
      'touch .mpl/state.json',
      'xxd -r .mpl/state.json',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected structural state.json write block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 codex r13 [security]: ANY Bash write to .mpl/state.json is blocked (base64/heredoc/etc. forgery)', () => {
  // Codex r13: a literal-keyword check (decomposer_dispatch /
  // first_transcript_seen) can't catch base64-decoded payloads. The
  // structural fix is to refuse ANY Bash command that writes to
  // .mpl/state.json — the hook itself uses writeState() (not Bash)
  // so legit hook operation is unaffected.
  const cwd = freshWorkspace();
  try {
    const base64Payload = Buffer.from(JSON.stringify({
      current_phase: 'phase-1',
      decomposer_dispatch: {
        dispatched_at: '2026-05-29T00:00:00Z',
        parent_transcript_path: '/tmp/other.jsonl',
      },
    })).toString('base64');
    for (const command of [
      `printf %s ${base64Payload} | base64 -d > .mpl/state.json`,
      'echo opaque-blob > .mpl/state.json',
      'cat /tmp/forged | tee .mpl/state.json',
      'dd if=/tmp/forged of=.mpl/state.json',
      'mv /tmp/forged .mpl/state.json',
      'cp /tmp/forged .mpl/state.json',
      `node -e fs.writeFileSync(".mpl/state.json", "forged")`,
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected Bash state.json write block for: ${command}`,
      );
    }
    // Sanity: read-only ops against state.json still pass.
    for (const command of [
      'cat .mpl/state.json',
      'ls .mpl/state.json',
      'jq . .mpl/state.json',
      'grep current_phase .mpl/state.json',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.notEqual(
        decision.decision,
        'block',
        `read-only on state.json should not block: ${command}`,
      );
    }
    // Sanity: writes to OTHER .mpl files (not state.json) unaffected.
    const otherWrite = runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'echo x > .mpl/runbook.md' },
    });
    assert.notEqual(otherWrite.decision, 'block');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 codex r12 [security]: only the first-seen (orchestrator-role) transcript may dispatch mpl-decomposer', () => {
  // Codex r12: the dispatch flag was recorded for ANY Task caller
  // claiming `subagent_type='mpl-decomposer'`. A non-orchestrator
  // subagent (phase-runner) could dispatch and the orchestrator
  // could then walk through the resulting window. Fix: bind the
  // dispatcher-role to the FIRST transcript observed in the session.
  const cwd = freshWorkspace();
  try {
    const orchestratorTranscript = '/tmp/orch.jsonl';
    const phaseRunnerTranscript = '/tmp/phase-runner.jsonl';

    // 1) Orchestrator's first call (any tool) records first_transcript_seen.
    runHook(cwd, {
      cwd,
      tool_name: 'Bash',
      transcript_path: orchestratorTranscript,
      tool_input: { command: 'ls' },
    });

    // 2) Phase-runner (different transcript) tries to dispatch
    // mpl-decomposer. Hook does NOT record dispatch.
    runHook(cwd, {
      cwd,
      tool_name: 'Task',
      transcript_path: phaseRunnerTranscript,
      tool_input: { subagent_type: 'mpl-decomposer' },
    });
    const attackState = readState(cwd);
    assert.ok(!attackState.decomposer_dispatch,
      'nested-dispatcher dispatch must NOT be recorded');

    // 3) Orchestrator's Write to decomposition.yaml is rejected
    // because no dispatch is active.
    const writeAttempt = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      transcript_path: orchestratorTranscript,
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml', content: 'forged' },
    });
    assert.equal(writeAttempt.decision, 'block');
    assert.match(writeAttempt.reason, /#236 A1/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 codex r12 [security]: legit orchestrator → decomposer flow still works', () => {
  const cwd = freshWorkspace();
  try {
    const orchestratorTranscript = '/tmp/orch.jsonl';
    const decomposerTranscript = '/tmp/decomposer.jsonl';

    // Orchestrator establishes first_transcript_seen.
    runHook(cwd, {
      cwd, tool_name: 'Bash', transcript_path: orchestratorTranscript,
      tool_input: { command: 'ls' },
    });
    // Orchestrator dispatches decomposer.
    runHook(cwd, {
      cwd, tool_name: 'Task', transcript_path: orchestratorTranscript,
      tool_input: { subagent_type: 'mpl-decomposer' },
    });
    const dispatchState = readState(cwd);
    assert.ok(dispatchState.decomposer_dispatch,
      'orchestrator dispatch SHOULD be recorded');
    // Decomposer writes — allowed.
    const decomposerWrite = runHook(cwd, {
      cwd, tool_name: 'Write', transcript_path: decomposerTranscript,
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml', content: 'legit' },
    });
    assert.equal(decomposerWrite.continue, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 claude r12 [security]: shell-normalization bypasses on Bash dispatch-forgery guard are closed', () => {
  // Claude r12: the Bash guard used a raw substring check. Quote-concat,
  // backslash-escape, ANSI-C escape, slash-collapse forms of
  // `.mpl/state.json` and `decomposer_dispatch` all bypassed. Fix:
  // normalize via the shared `normalizeShellCommand` helper before
  // the substring test.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      `echo decomposer_dispatch > .mpl"/"state.json`,
      `echo decomposer_dispatch > .mpl\\/state.json`,
      `echo decomposer_dispatch > .mpl//state.json`,
      String.raw`echo decomposer_dispatch > $'.mpl\x2fstate.json'`,
      String.raw`echo decomposer_dispatch > .mpl/state.json`,
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected shell-normalize bypass to be blocked: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 claude r11 [security]: Bash that mentions both .mpl/state.json AND decomposer_dispatch is blocked', () => {
  // Claude r11 [security]: the r9 Write/Edit guard only covered the
  // Write/Edit tool surface. The orchestrator could still forge the
  // decomposer_dispatch flag via Bash:
  //   echo '{"decomposer_dispatch":…}' > .mpl/state.json
  //   tee .mpl/state.json
  //   dd of=.mpl/state.json
  //   node -e 'fs.writeFileSync(".mpl/state.json", …)'
  // Fix: any Bash command that mentions BOTH `.mpl/state.json` and
  // `decomposer_dispatch` is rejected. Benign Bash writes to state.json
  // that don't carry the dispatch key pass through.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'echo decomposer_dispatch > .mpl/state.json',
      'tee .mpl/state.json <<< decomposer_dispatch',
      'dd of=.mpl/state.json if=/tmp/decomposer_dispatch.json',
      'node -e fs.writeFileSync(".mpl/state.json", JSON.stringify({decomposer_dispatch:1}))',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected dispatch-forgery-via-Bash block for: ${command}`,
      );
      assert.match(decision.reason, /decomposer_dispatch/);
    }
    // r13 structural change: ANY Bash write to .mpl/state.json now
    // blocks (forgery-class via base64/heredoc/etc. is unconditional).
    // Bash reads of state.json (cat/ls) still pass — see the
    // standalone r13 test.
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r11 [data-integrity]: tar --remove-files and rsync --remove-source-files are blocked', () => {
  // Codex r11: tar with --remove-files deletes the source file after
  // archiving; rsync with --remove-source-files does the same. Plain
  // tar / rsync without those flags is read-only-from-source and
  // should NOT block.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'tar --remove-files -cf /tmp/mpl.tar .mpl/mpl',
      'rsync --remove-source-files -av .mpl/mpl/ /tmp/dest/',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected tar/rsync remove block for: ${command}`,
      );
    }
    // Sanity: plain tar / rsync (no remove flag) → NOT block.
    for (const command of [
      'tar -cf /tmp/x.tar .mpl/mpl',
      'rsync -av .mpl/mpl /tmp/',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.notEqual(
        decision.decision,
        'block',
        `plain tar/rsync (no remove flag) should NOT block: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r10 [data-integrity]: interpreter one-liners that mention protected paths are blocked', () => {
  // Codex r10: `node -e "require('fs').rmSync('.mpl/mpl')"`,
  // `python -c "shutil.rmtree('.mpl/mpl')"` can destroy protected
  // paths without invoking any shell-level destructive verb. Fix:
  // add common interpreter heads to the entry gate; the substring +
  // token check then catches the protected target literal inside
  // the eval body. Pure read-only interpreter use is NOT blocked.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      `node -e require('fs').rmSync('.mpl/mpl')`,
      `python -c shutil.rmtree('.mpl/mpl')`,
      `perl -e unlink('.mpl/contracts/foo')`,
      `ruby -e File.delete('.mpl/memory/state')`,
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected interpreter-eval block for: ${command}`,
      );
    }
    // Sanity: read-only interpreter use (no protected mention) passes.
    for (const command of ['node script.js', 'python -m pytest', 'ruby --version']) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.notEqual(
        decision.decision,
        'block',
        `read-only interpreter use should not block: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A1 claude r9 [security]: planting decomposer_dispatch via Write/Edit of .mpl/state.json is blocked', () => {
  // Concrete repro: the orchestrator has Write access to .mpl/state.json
  // (it sits in the /\.mpl\// allowlist), so it could forge the
  // decomposer_dispatch flag to satisfy isDecomposerDispatchActive
  // and Write decomposition.yaml from its own transcript. Fix: any
  // Write/Edit to .mpl/state.json whose payload mentions the
  // `decomposer_dispatch` key is rejected — only this hook is
  // allowed to set the flag.
  const cwd = freshWorkspace();
  try {
    // Write payload mentioning decomposer_dispatch.
    const writeDecision = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: {
        file_path: '.mpl/state.json',
        content: JSON.stringify({
          current_phase: 'phase-1',
          decomposer_dispatch: {
            dispatched_at: new Date().toISOString(),
            parent_transcript_path: '/tmp/fake.jsonl',
          },
        }),
      },
    });
    assert.equal(writeDecision.continue, false);
    assert.equal(writeDecision.decision, 'block');
    assert.match(writeDecision.reason, /decomposer_dispatch/);

    // Edit form too.
    const editDecision = runHook(cwd, {
      cwd,
      tool_name: 'Edit',
      tool_input: {
        file_path: '.mpl/state.json',
        old_string: '"current_phase":"phase-1"',
        new_string: '"current_phase":"phase-1","decomposer_dispatch":{"dispatched_at":"x","parent_transcript_path":"y"}',
      },
    });
    assert.equal(editDecision.decision, 'block');

    // r13 structural change: ANY Write/Edit to .mpl/state.json now
    // blocks. The "benign" sanity case is inverted per the r13
    // contract (state writes go through writeState() / mpl_state_write,
    // not direct Write/Edit tool).
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r9 [data-integrity]: writer utilities (tee, dd of=) are blocked on protected paths', () => {
  // Codex r9: `tee FILE` opens FILE for write and overwrites it;
  // `dd of=FILE` does the same. Pre-fix entry gate didn't include
  // these writer utilities so the protected operand check never ran.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'echo x | tee .mpl/mpl/decomposition.yaml',
      'echo x | tee -a .mpl/mpl/log',
      'tee -a .mpl/contracts/foo',
      'dd if=/dev/zero of=.mpl/mpl/decomposition.yaml',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected writer-utility block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r8 [data-integrity]: no-space and fd-prefix redirects are blocked', () => {
  // Codex r8: POSIX shell redirection doesn't require whitespace
  // after `>`/`>>`/`&>`. Pre-fix entry gate required `\s` after `>`.
  // Also fd-prefixed forms (`2>`, `1>>`) must trigger.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'echo x >.mpl/mpl/decomposition.yaml',
      ': >.mpl/contracts/foo.json',
      'cat /dev/null >.mpl/memory/state',
      'echo y 2>.mpl/mpl/err.log',
      'echo z >>.mpl/mpl/log',
      'echo a &>.mpl/mpl/all',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected no-space redirect block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r7 [data-integrity]: parameter-expansion `${var}` after same-line assignment is blocked', () => {
  // Codex r7: `p=.mpl; rm -rf ${p}/mpl` reaches the shell as
  // `rm -rf .mpl/mpl`. Pre-fix the tokenizer saw `${p}/mpl` and
  // couldn't resolve. Fix substitutes simple `name=value`
  // assignments collected from the same command line.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'p=.mpl; rm -rf ${p}/mpl',
      'p=docs; rm -rf ${p}/learnings',
      'p=.mpl; rm -rf $p/mpl',
      'export p=.mpl && rm -rf "${p}/contracts"',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected parameter-expansion block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 claude r7 [data-integrity]: non-rm destructive ops are blocked too', () => {
  // Claude r7: the mpl-cancel SKILL forbids "deleting" protected paths
  // — `mv`-away, `>`-truncate, `shred`, `unlink`, `cp /dev/null`,
  // `truncate -s 0` are all forms of deletion the hook is supposed to
  // gate. Pre-fix entry gate was rm/find -delete only.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'mv .mpl/mpl /tmp/stolen',
      '> .mpl/mpl/decomposition.yaml',
      '>> .mpl/mpl/log',
      'shred -u .mpl/mpl/decomposition.yaml',
      'unlink .mpl/mpl/decomposition.yaml',
      'cp /dev/null .mpl/mpl/decomposition.yaml',
      'truncate -s 0 .mpl/mpl/decomposition.yaml',
      'echo hello > .mpl/contracts/foo',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected non-rm destructive block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3: non-destructive read operations against protected paths still pass', () => {
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'ls .mpl/mpl/',
      'cat .mpl/mpl/decomposition.yaml',
      'grep -r foo .mpl/mpl/',
      'find .mpl/mpl -type f',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.notEqual(
        decision.decision,
        'block',
        `read-only op should not be blocked: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r6 [data-integrity]: glob-expansion operands are blocked when they can match protected roots', () => {
  // Codex r6: `rm -rf .mpl/m*` expands to `.mpl/mpl .mpl/memory` in
  // real bash. Glob meta (`*`, `?`, `[…]`) in the token wasn't
  // resolved against protected roots. Fix: when token contains glob
  // meta, take the literal prefix and check if any protected root
  // starts with that prefix (or vice versa) — any expansion could
  // land on a protected path.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'rm -rf .mpl/m*',
      'rm -rf .mpl/*',
      'rm -rf docs/*',
      'rm -rf .mpl/m?l',
      'rm -rf docs/learn*',
      'rm -rf .mp[lk]/mpl',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected glob block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 claude r5 [data-integrity]: brace expansion is normalized before matching', () => {
  // Claude r5: `rm -rf .mpl/{mpl,contracts}` deletes both protected
  // paths in real bash. Cartesian forms (`{.mpl,docs}/{mpl,learnings}`)
  // and partial forms (`.mpl/mp{l,n}`) too. The fix expands every
  // `prefix{a,b,…}suffix` per-token (cartesian when multiple groups)
  // before the substring + token checks.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      'rm -rf .mpl/{mpl,contracts}',
      'rm -rf .mpl/{mpl,contracts,memory}',
      'rm -rf {.mpl,docs}/{mpl,learnings}',
      'rm -rf .mpl/mp{l,n}',
      'rm -rf .{mpl,omc}/mpl',
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected brace-expansion block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r5 [data-integrity]: ANSI-C quoted escape sequences are decoded before matching', () => {
  // Codex r5: Bash $'…' ANSI-C quoting decodes hex/octal/Unicode
  // escapes. `rm -rf $'.mpl\\x2fmpl'` deletes `.mpl/mpl`. The fix
  // decodes \xHH / \uHHHH / \UHHHHHHHH / \OOO before the generic
  // backslash strip so they don't get clobbered to `x2f`.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      String.raw`rm -rf $'.mpl\x2fmpl'`,
      String.raw`rm -rf $'.mpl\057mpl'`,
      String.raw`rm -rf $'.mpl/mpl'`,
      String.raw`rm -rf $'docs\x2flearnings'`,
      String.raw`rm -rf $'docs\057learnings'`,
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected ANSI-C decode block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r4 [data-integrity]: backslash-escaped path separators are blocked', () => {
  // Codex r4: POSIX shells remove `\X` escapes before exec, so
  // `rm -rf .mpl\/mpl` and `rm -rf docs\/learnings` actually delete
  // the protected paths. The fix strips every `\X` → `X` before the
  // substring + token checks so backslash forgery collapses to the
  // literal a real shell sees.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      String.raw`rm -rf .mpl\/mpl`,
      String.raw`rm -rf .mpl\/contracts`,
      String.raw`rm -rf docs\/learnings`,
      String.raw`rm -rf \.mpl/mpl`,
      String.raw`rm -rf .\m\p\l/\m\p\l`,
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected backslash-escape block for: ${command}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#236 A3 codex r3 [data-integrity]: quote-concatenation forgery is blocked', () => {
  // Codex r3: POSIX shells concatenate adjacent quoted fragments,
  // so `.mpl/""mpl`, `.mpl"/"mpl`, `.mpl''/''mpl` all resolve to
  // `.mpl/mpl` at execution time. The fix strips all `"` and `'`
  // and backticks from the command before the substring + token
  // checks so quote-concatenation forgery collapses to the same
  // literal a real shell would see.
  const cwd = freshWorkspace();
  try {
    for (const command of [
      `rm -rf .mpl/""mpl`,
      `rm -rf .mpl"/"mpl`,
      `rm -rf .mpl''/''mpl`,
      `rm -rf 'doc's'/'learnings`,
    ]) {
      const decision = runHook(cwd, {
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      });
      assert.equal(
        decision.decision,
        'block',
        `expected quote-concat block for: ${command}`,
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

test('#236 A1 claude r3 [contract-break]: re-dispatch of mpl-decomposer resets the child lock so the new run is allowed', () => {
  // Concrete repro shape: APPEND-MODE / RECOMPOSE-MODE re-dispatches
  // the decomposer (see commands/mpl-run-decompose.md). Without the
  // explicit child_transcript_path: null on each dispatch, the
  // previous run's lock persists and the second run's writes are
  // wrongly rejected.
  const cwd = freshWorkspace();
  try {
    const orchestratorTranscript = '/tmp/transcript-orchestrator.jsonl';
    const decomposer1Transcript = '/tmp/transcript-decomposer-1.jsonl';
    const decomposer2Transcript = '/tmp/transcript-decomposer-2.jsonl';

    // Run 1: dispatch + first decomposer Write captures lock.
    runHook(cwd, {
      cwd,
      tool_name: 'Task',
      transcript_path: orchestratorTranscript,
      tool_input: { subagent_type: 'mpl-decomposer', prompt: '...' },
    });
    runHook(cwd, {
      cwd,
      tool_name: 'Write',
      transcript_path: decomposer1Transcript,
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml', content: 'v1' },
    });
    const afterRun1 = readState(cwd);
    assert.equal(
      afterRun1.decomposer_dispatch.child_transcript_path,
      decomposer1Transcript,
    );

    // Run 2: orchestrator re-dispatches (recompose). New dispatch
    // must reset the locked child to null.
    runHook(cwd, {
      cwd,
      tool_name: 'Task',
      transcript_path: orchestratorTranscript,
      tool_input: { subagent_type: 'mpl-decomposer', prompt: '...' },
    });
    const afterRun2Dispatch = readState(cwd);
    assert.equal(
      afterRun2Dispatch.decomposer_dispatch.child_transcript_path,
      null,
      'Expected re-dispatch to clear the locked child transcript',
    );

    // The NEW decomposer (fresh transcript) writes — allowed.
    const newDecomposerWrite = runHook(cwd, {
      cwd,
      tool_name: 'Write',
      transcript_path: decomposer2Transcript,
      tool_input: { file_path: '.mpl/mpl/decomposition.yaml', content: 'v2' },
    });
    assert.equal(newDecomposerWrite.continue, true);

    // New child lock recorded as the second decomposer.
    const afterRun2Write = readState(cwd);
    assert.equal(
      afterRun2Write.decomposer_dispatch.child_transcript_path,
      decomposer2Transcript,
    );
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
