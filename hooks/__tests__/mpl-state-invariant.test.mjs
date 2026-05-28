import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  checkInvariants,
  formatViolations,
  TRIGGERS,
  VIOLATION_IDS,
  CURRENT_SCHEMA_VERSION,
} from '../lib/mpl-state-invariant.mjs';

// Test fixtures must declare the version they're parameterized for so a
// future bump doesn't trigger a migration mid-test (which mutates the
// state file and breaks Edit-simulation lookups via stale old_string).
const SCHEMA_V = CURRENT_SCHEMA_VERSION;

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-state-invariant.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-inv-'));
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function withState(s) {
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify(s));
}

function makePhaseFolders(n) {
  for (let i = 1; i <= n; i++) {
    mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', `phase-${i}`), { recursive: true });
  }
}

/* ────────────────────────── lib unit ──────────────────────────────────── */

describe('checkInvariants — basics', () => {
  it('null/undefined state → ok=true', () => {
    assert.deepStrictEqual(checkInvariants(null), { ok: true, violations: [] });
    assert.deepStrictEqual(checkInvariants(undefined), { ok: true, violations: [] });
  });

  it('empty state → ok=true', () => {
    assert.strictEqual(checkInvariants({}, { cwd: tmp }).ok, true);
  });

  it('clean realistic state → ok=true', () => {
    makePhaseFolders(2);
    // Both phase folders carry state-summary.md → counted as completed.
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'state-summary.md'), '# done');
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2', 'state-summary.md'), '# done');
    const r = checkInvariants({
      current_phase: 'phase2-sprint',
      finalize_done: false,
      session_status: 'active',
      schema_version: SCHEMA_V,
      execution: { phases: { completed: 2 } },
      fix_loop_count: 3,
      fix_loop_history: [{ phase: 'p1', count: 2 }, { phase: 'p2', count: 1 }],
    }, { cwd: tmp });
    assert.strictEqual(r.ok, true, JSON.stringify(r.violations, null, 2));
  });
});

describe('I1 paused_budget AND finalize_done', () => {
  it('flags the contradiction', () => {
    const r = checkInvariants({ session_status: 'paused_budget', finalize_done: true }, { cwd: tmp });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.violations[0].id, VIOLATION_IDS.PAUSED_BUT_FINALIZED);
  });
});

describe('I2 completed AND !finalize_done', () => {
  it('flags the contradiction', () => {
    const r = checkInvariants({ current_phase: 'completed', finalize_done: false }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.COMPLETED_BUT_NOT_FINALIZED));
  });
  it('completed AND finalize_done=true is fine', () => {
    const r = checkInvariants({ current_phase: 'completed', finalize_done: true }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.COMPLETED_BUT_NOT_FINALIZED));
  });
});

describe('I3 paused/hung blocks new dispatch', () => {
  for (const status of ['paused_budget', 'paused_checkpoint', 'verification_hang']) {
    it(`flags new Task/Agent dispatch under ${status}`, () => {
      const r = checkInvariants(
        { session_status: status },
        { cwd: tmp, trigger: TRIGGERS.TASK_DISPATCH },
      );
      assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.PAUSED_NEW_DISPATCH));
    });
  }
  it('does NOT flag dispatch under active', () => {
    const r = checkInvariants(
      { session_status: 'active' },
      { cwd: tmp, trigger: TRIGGERS.TASK_DISPATCH },
    );
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PAUSED_NEW_DISPATCH));
  });
  it('paused under STOP trigger is not I3 (I1/I2 may apply but I3 does not)', () => {
    const r = checkInvariants(
      { session_status: 'paused_budget' },
      { cwd: tmp, trigger: TRIGGERS.STOP },
    );
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PAUSED_NEW_DISPATCH));
  });

  it("PR #128 nit #1: 'cancelled' session does NOT block dispatch (cleanup Tasks allowed)", () => {
    // The DISPATCH_BLOCKED_STATUSES set intentionally excludes `cancelled` —
    // a cancelled pipeline may still need to dispatch cleanup Tasks before
    // the session truly exits. The exclusion is documented in lib code.
    const r = checkInvariants(
      { session_status: 'cancelled' },
      { cwd: tmp, trigger: TRIGGERS.TASK_DISPATCH },
    );
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PAUSED_NEW_DISPATCH));
  });
});

describe('I4 phase folder count vs execution.phases.completed', () => {
  function markCompleted(n) {
    // Only phase-N directories carrying state-summary.md count as completed.
    for (let i = 1; i <= n; i++) {
      writeFileSync(
        join(tmp, '.mpl', 'mpl', 'phases', `phase-${i}`, 'state-summary.md'),
        '# done',
      );
    }
  }

  it('flags mismatch when 3 phases completed but state says 1', () => {
    makePhaseFolders(3);
    markCompleted(3);
    const r = checkInvariants({ execution: { phases: { completed: 1 } } }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_MISMATCH));
  });
  it('match passes when 3 completed and state agrees', () => {
    makePhaseFolders(3);
    markCompleted(3);
    const r = checkInvariants({ execution: { phases: { completed: 3 } } }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_MISMATCH));
  });
  it('no execution subtree → not measurable', () => {
    makePhaseFolders(3);
    const r = checkInvariants({}, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_MISMATCH));
  });

  it('PR #128 review #1: decompose-pre-created phase-N dirs without state-summary do NOT count', () => {
    // commands/mpl-run-decompose.md Step 4 pre-creates every phase-N/ directory
    // before any phase runs; Step 5 initializes execution.phases.completed=0.
    // I4 must read the disk-truth that matches phase-runner finalize artifacts
    // (state-summary.md), not raw directory existence.
    makePhaseFolders(3); // empty dirs only — no state-summary.md
    const r = checkInvariants({
      current_phase: 'phase2-sprint',
      execution: { phases: { total: 3, completed: 0 } },
    }, { cwd: tmp });
    assert.ok(
      !r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_MISMATCH),
      `expected no I4 false positive, got: ${JSON.stringify(r.violations, null, 2)}`,
    );
  });
});

describe('I5 fix_loop_count vs fix_loop_history', () => {
  it('flags desync', () => {
    const r = checkInvariants({
      fix_loop_count: 5,
      fix_loop_history: [{ phase: 'p1', count: 2 }, { phase: 'p2', count: 1 }],
    }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
  });
  it('matching count passes', () => {
    const r = checkInvariants({
      fix_loop_count: 3,
      fix_loop_history: [{ phase: 'p1', count: 2 }, { phase: 'p2', count: 1 }],
    }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
  });
  it('no history → not measurable', () => {
    const r = checkInvariants({ fix_loop_count: 5 }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
  });
  it('numeric history entries also work', () => {
    const r = checkInvariants({
      fix_loop_count: 3,
      fix_loop_history: [1, 2],
    }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
  });
});

describe('I6 phase3-gate state-write missing structured evidence', () => {
  const ent = (exit_code) => ({ command: 'npm test', exit_code, stdout_tail: '', timestamp: 'now' });

  it('all three structured → no violation', () => {
    const r = checkInvariants({
      current_phase: 'phase3-gate',
      gate_results: { hard1_baseline: ent(0), hard2_coverage: ent(0), hard3_resilience: ent(0) },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_EVIDENCE_MISSING));
  });

  it('partial structured → violation lists missing names', () => {
    const r = checkInvariants({
      current_phase: 'phase3-gate',
      gate_results: { hard1_baseline: ent(0) },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_EVIDENCE_MISSING);
    assert.ok(v);
    assert.deepStrictEqual(v.missing.sort(), ['hard2_coverage', 'hard3_resilience']);
  });

  it('not phase3-gate → not checked', () => {
    const r = checkInvariants({
      current_phase: 'phase2-sprint',
      gate_results: {},
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_EVIDENCE_MISSING));
  });

  it('STOP trigger → not checked (mpl-phase-controller already gates)', () => {
    const r = checkInvariants({
      current_phase: 'phase3-gate',
      gate_results: {},
    }, { cwd: tmp, trigger: TRIGGERS.STOP });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_EVIDENCE_MISSING));
  });
});

describe('I12 gate command-family mismatch (Exp22 R13 / #209)', () => {
  function gateEntry(command) {
    return { command, exit_code: 0, stdout_tail: '', timestamp: 'now' };
  }

  it('valid Hard 1/2/3 commands → no violation', () => {
    const r = checkInvariants({
      gate_results: {
        hard1_baseline: gateEntry('npm run build'),
        hard2_coverage: gateEntry('npm test'),
        hard3_resilience: gateEntry('npx playwright test'),
      },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH));
  });

  it('git commit in hard2_coverage → violation names offending key+command', () => {
    const r = checkInvariants({
      gate_results: {
        hard2_coverage: gateEntry('git commit -m "tests done"'),
      },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
    assert.ok(v, 'violation must fire');
    assert.match(v.message, /state\.gate_results\.hard2_coverage/);
    assert.match(v.message, /git commit/);
    assert.equal(v.mismatches[0].gate, 'state.gate_results.hard2_coverage');
    assert.equal(v.mismatches[0].expected_family, 'hard2_coverage');
  });

  it('git commit in hard3_resilience → violation', () => {
    const r = checkInvariants({
      gate_results: {
        hard3_resilience: gateEntry('git commit -m "e2e"'),
      },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
    assert.ok(v);
    assert.match(v.message, /hard3_resilience/);
  });

  it('release-scoped state.release.gate_results is also checked', () => {
    const r = checkInvariants({
      release: {
        gate_results: {
          hard2_coverage: gateEntry('echo done'),
        },
      },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
    assert.ok(v);
    assert.match(v.message, /state\.release\.gate_results\.hard2_coverage/);
  });

  it('legacy booleans true with invalid structured command still blocks', () => {
    const r = checkInvariants({
      gate_results: {
        hard1_passed: true,
        hard2_passed: true,
        hard3_passed: true,
        hard1_baseline: gateEntry('git commit'),
      },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH));
  });

  it('shell-wrapped non-gate commands are rejected (codex r3 [data-integrity])', () => {
    // Codex r3 on PR #219: `bash -lc "git commit -m e2e"` would otherwise
    // classify as hard3_resilience via the embedded `e2e` keyword. Adding
    // shell wrappers to the denylist forces the classifier to return null
    // for any bash/sh/zsh/... -wrapped command.
    for (const cmd of [
      'bash -lc "git commit -m e2e"',
      'bash -lc "echo e2e contract"',
      'sh -c "git push origin main"',
      '/bin/zsh -lc "playwright test"',
      'dash -c "echo skipped"',
    ]) {
      const r = checkInvariants({
        gate_results: {
          hard3_resilience: gateEntry(cmd),
        },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
      assert.ok(v, `shell-wrapped command must be rejected: ${cmd}`);
    }
  });

  it('script-interpreter eval forms (node -e, python -c) are rejected (codex r7 [data-integrity])', () => {
    // Codex r7 on PR #219: even with the head denylist + wrapper-flag
    // guards, a manual write like `node -e "console.log('npm test')"`
    // would slip past because `node` was not denied AND the full
    // command string contains the `npm test` keyword. Strict classifier
    // is now allowlist-based: only known test/build heads.
    for (const cmd of [
      'node -e "console.log(\'npm test\')"',
      'node -e "playwright"',
      'python -c "print(\'e2e contract\')"',
      'python3 -c "print(\'npm test\')"',
      'ruby -e "puts \'jest\'"',
      'perl -e "print qq{vitest}"',
      'php -r "echo \'go test\';"',
      'awk \'BEGIN{print "npm test"}\'',
    ]) {
      const r = checkInvariants({
        gate_results: {
          hard2_coverage: gateEntry(cmd),
        },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
      assert.ok(v, `script-interpreter eval form must be rejected: ${cmd}`);
    }
  });

  it('#220: composite shell forms (semicolon / && / ||) are rejected at the strict level', () => {
    // Empirical bypass: `npm test; git commit -m e2e` has head `npm`
    // (allowlisted) but the family regex sees `e2e` downstream and
    // classifies as hard3. Manual gate evidence is a single command;
    // composite/pipe/subshell shells fail closed.
    for (const cmd of [
      'npm test; git commit -m e2e',
      'npm test && git commit -m playwright',
      'npm run build || echo failed',
      'npm test; touch e2e.json',
      'tsc --noEmit; echo "playwright"',
    ]) {
      const r = checkInvariants({
        gate_results: {
          hard2_coverage: gateEntry(cmd),
        },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
      assert.ok(v, `composite shell form must be rejected at strict level: ${cmd}`);
    }
  });

  it('#220: pipes and command substitution are rejected at the strict level', () => {
    for (const cmd of [
      'npm test | tee output.log',
      'echo "$(npm test)"',
      'cat fake-log | grep e2e',
      'npm test `echo --quiet`',
    ]) {
      const r = checkInvariants({
        gate_results: {
          hard2_coverage: gateEntry(cmd),
        },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
      assert.ok(v, `pipe / command substitution must be rejected: ${cmd}`);
    }
  });

  it('#220 codex r1 [data-integrity]: newline / single & / process substitution rejected at strict level', () => {
    // Codex r1 on PR #231 expanded the bypass list beyond `;` / `&&` /
    // `||` / `|` / backticks / `$(` to:
    //  - newline (also a statement separator in bash)
    //  - single `&` (background — splits the command line)
    //  - process substitution `<(...)` / `>(...)`
    //  - brace grouping `{...}`
    for (const cmd of [
      'npm test\ngit commit -m e2e',
      'npm test\rgit commit -m playwright',
      'npm test & git commit -m e2e',
      'npm test <(echo e2e)',
      'npm test >(touch e2e.out)',
      '{ npm test; git commit -m e2e; }',
    ]) {
      const r = checkInvariants({
        gate_results: {
          hard2_coverage: gateEntry(cmd),
        },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
      assert.ok(v, `extended bypass shape must be rejected: ${JSON.stringify(cmd)}`);
    }
  });

  it('#220 codex r3 [data-integrity]: recorder classifier also strips redirect/comment suffix before family match', async () => {
    // The recorder path (classifyRecordedCommand) is intentionally
    // looser than the strict path — it accepts wrapper invocations like
    // `bash -lc "npm test"`. But it was still classifying
    // `npm test > playwright` as hard3 because the family regex saw
    // `playwright` in the redirect target. Cut at the first redirect /
    // comment operator BEFORE classifying so the regex only sees what
    // the shell actually executed.
    const { classifyRecordedCommand } = await import(
      '../lib/mpl-gate-classify.mjs'
    );
    assert.equal(classifyRecordedCommand('npm test > playwright'), 'hard2_coverage');
    assert.equal(classifyRecordedCommand('npm test 2> e2e.log'), 'hard2_coverage');
    assert.equal(classifyRecordedCommand('npm test # e2e'), 'hard2_coverage');
    assert.equal(classifyRecordedCommand('npm test >> playwright.log'), 'hard2_coverage');
    assert.equal(classifyRecordedCommand('tsc --noEmit > playwright.txt'), 'hard1_baseline');
    // Legitimate wrappers still classify correctly:
    assert.equal(classifyRecordedCommand('npx playwright test'), 'hard3_resilience');
    assert.equal(classifyRecordedCommand('docker compose run app npm test'), 'hard2_coverage');
    assert.equal(classifyRecordedCommand('bash -lc "npx playwright test"'), 'hard3_resilience');
  });

  it('#220 codex r2 [data-integrity]: redirection and comment text rejected at strict level', () => {
    // Codex r2 on PR #231: `npm test > playwright`, `npm test 2> e2e`,
    // `npm test # e2e` — the shell never executes the trailing text,
    // but the family regex saw the keyword and classified as hard3.
    // Redirection / comments are not legitimate manual gate evidence.
    for (const slot of ['hard2_coverage', 'hard3_resilience']) {
      for (const cmd of [
        'npm test > playwright',
        'npm test 2> e2e.log',
        'npm test > /tmp/playwright.out',
        'npm test # e2e',
        'npm test < input.txt',
        'tsc --noEmit > playwright.txt',
      ]) {
        const r = checkInvariants({
          gate_results: { [slot]: gateEntry(cmd) },
        }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
        const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
        assert.ok(v, `redirection/comment masquerade must reject in ${slot}: ${cmd}`);
      }
    }
  });

  it('#220 codex r1 [data-integrity]: bypass shapes also rejected when placed directly in hard3_resilience slot', () => {
    // Codex recommended: previous tests only put bypass commands in
    // hard2_coverage (a slot mismatch). Verify the strict gate also
    // rejects them when matched against their would-be claimed slot.
    for (const cmd of [
      'npm test\ngit commit -m e2e',
      'npm test & touch e2e.json',
      'npm test <(echo playwright)',
      'npm test; touch playwright.spec',
    ]) {
      const r = checkInvariants({
        gate_results: {
          hard3_resilience: gateEntry(cmd),
        },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
      assert.ok(v, `bypass placed in hard3 slot must still be rejected: ${JSON.stringify(cmd)}`);
    }
  });

  it('strict classifier still accepts known gate heads on the allowlist', () => {
    // Sanity: pnpm/yarn/npx/cargo/go all in allowlist; family regex
    // narrows them into the right slot.
    const cases = [
      { command: 'pnpm test', slot: 'hard2_coverage' },
      { command: 'yarn run test', slot: 'hard2_coverage' },
      { command: 'pnpm run build', slot: 'hard1_baseline' },
      { command: 'cargo test', slot: 'hard2_coverage' },
      { command: 'cargo build', slot: 'hard1_baseline' },
      { command: 'go test ./...', slot: 'hard2_coverage' },
      { command: 'npx playwright test', slot: 'hard3_resilience' },
      { command: 'tsc --noEmit', slot: 'hard1_baseline' },
    ];
    for (const c of cases) {
      const r = checkInvariants({
        gate_results: { [c.slot]: gateEntry(c.command) },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH),
        `allowlisted head should pass: ${c.command}`);
    }
  });

  it('prefix wrappers with flag options still resolve to inner head (codex r5 [data-integrity])', () => {
    // Codex r5 on PR #219: `sudo -E git`, `env -u FOO git`, `time -p git`,
    // `nice -n 5 git` would all bypass denylist if the head extractor
    // stopped at `-E` / `-u` / `-p` / `-n`. Skip flag tokens after a
    // wrapper prefix until the real executable is reached.
    for (const cmd of [
      'sudo -E git commit -m e2e',
      'sudo -u root git commit -m e2e',
      'env -u FOO git commit -m e2e',
      'env --unset=FOO git commit -m e2e',
      'time -p git commit -m e2e',
      'nice -n 5 git commit -m e2e',
    ]) {
      const r = checkInvariants({
        gate_results: {
          hard3_resilience: gateEntry(cmd),
        },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
      assert.ok(v, `wrapper-with-flags command must be rejected: ${cmd}`);
    }
  });

  it('eval/subshell-wrapped non-gate commands are rejected (codex+claude r4 [data-integrity])', () => {
    // Codex+claude r4 on PR #219: shell-evaluation primitives (`eval`,
    // subshell `(...)`, backticks, `$(...)`) must not let git commit
    // smuggle the e2e keyword into hard3_resilience.
    for (const cmd of [
      'eval "git commit -m e2e"',
      'eval git push',
      '(git commit -m e2e)',
      '`git commit -m e2e`',
      '$(git commit -m e2e)',
    ]) {
      const r = checkInvariants({
        gate_results: {
          hard3_resilience: gateEntry(cmd),
        },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
      assert.ok(v, `wrapped command must be rejected: ${cmd}`);
    }
  });

  it('path-qualified git command still blocks (codex r1 [data-integrity])', () => {
    // Codex r1 on PR #219: `/usr/bin/git commit -m "e2e"` would bypass
    // the head denylist if we only matched the literal token. extractCommandHead
    // now reduces to basename so the denylist catches it.
    for (const cmd of [
      '/usr/bin/git commit -m "e2e fix"',
      '/opt/homebrew/bin/git push origin main',
      'env VAR=1 /usr/local/bin/git tag',
      'sudo /usr/bin/git commit -am "release"',
    ]) {
      const r = checkInvariants({
        gate_results: {
          hard3_resilience: gateEntry(cmd),
        },
      }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
      assert.ok(v, `path-qualified git must still be rejected: ${cmd}`);
    }
  });

  it('wrong-family classified command also blocks (build in hard2 slot)', () => {
    const r = checkInvariants({
      gate_results: {
        hard2_coverage: gateEntry('npm run build'),
      },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
    assert.ok(v);
    assert.equal(v.mismatches[0].classified_as, 'hard1_baseline');
    assert.equal(v.mismatches[0].expected_family, 'hard2_coverage');
  });

  it('STOP trigger → not checked (state-write boundary only)', () => {
    const r = checkInvariants({
      gate_results: { hard2_coverage: gateEntry('git commit') },
    }, { cwd: tmp, trigger: TRIGGERS.STOP });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH));
  });

  it('structured entry without command is rejected (codex r2 [data-integrity])', () => {
    // Codex r2 on PR #219: `{ exit_code: 0 }` with no command is a valid
    // structured entry by I6 but must NOT count as gate evidence.
    const r = checkInvariants({
      gate_results: {
        hard1_baseline: { exit_code: 0 },
        hard2_coverage: { exit_code: 0 },
        hard3_resilience: { exit_code: 0 },
      },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH);
    assert.ok(v, 'commandless gate entries must trigger I12');
    // All three slots must be in the mismatches list.
    const gates = v.mismatches.map((m) => m.gate).sort();
    assert.deepStrictEqual(gates, [
      'state.gate_results.hard1_baseline',
      'state.gate_results.hard2_coverage',
      'state.gate_results.hard3_resilience',
    ]);
    assert.equal(v.mismatches[0].classified_as, 'missing_command');
  });

  it('blank-command structured entry is rejected', () => {
    const r = checkInvariants({
      gate_results: {
        hard2_coverage: { command: '   ', exit_code: 0 },
      },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH));
  });

  it('null entry → not flagged', () => {
    const r = checkInvariants({
      gate_results: { hard2_coverage: null },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH));
  });

  it('entry without command IS flagged (manual exit_code-only writes are not gate evidence — codex r2)', () => {
    // Replaces the prior "not flagged" expectation. Per codex r2,
    // commandless entries MUST be rejected — a structured shape alone
    // without a recognized command does not constitute gate evidence.
    const r = checkInvariants({
      gate_results: { hard2_coverage: { exit_code: 0 } },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH));
  });
});

describe('I13 fast-track Phase 0 artifacts (Exp22 R11 / #210)', () => {
  function seedPhase0Artifacts(dir) {
    mkdirSync(join(dir, '.mpl', 'mpl', 'phase0'), { recursive: true });
    writeFileSync(join(dir, '.mpl', 'mpl', 'phase0', 'raw-scan.md'), '# raw scan');
    writeFileSync(join(dir, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'), 'goal: test\n');
    mkdirSync(join(dir, '.mpl', 'contracts'), { recursive: true });
    writeFileSync(join(dir, '.mpl', 'contracts', '_no-boundaries.json'),
      JSON.stringify({ boundary_id: '_no-boundaries' }));
  }

  it('phase2-sprint transition without Phase 0 artifacts → I13 violation lists missing files', () => {
    const r = checkInvariants({ current_phase: 'phase2-sprint' },
      { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.FAST_TRACK_PHASE0_ARTIFACTS_MISSING);
    assert.ok(v);
    assert.match(v.message, /raw-scan\.md/);
    assert.match(v.message, /design-intent\.yaml/);
    assert.match(v.message, /\.mpl\/contracts\/\*\.json/);
    assert.match(v.message, /_no-boundaries\.json/);
    assert.equal(v.phase, 'phase2-sprint');
  });

  it('phase2-sprint transition WITH all Phase 0 artifacts → silent', () => {
    seedPhase0Artifacts(tmp);
    const r = checkInvariants({ current_phase: 'phase2-sprint' },
      { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.FAST_TRACK_PHASE0_ARTIFACTS_MISSING));
  });

  it('phase5-finalize / release-finalize / completed transitions are also guarded', () => {
    for (const phase of ['phase3-gate', 'phase4-fix', 'phase5-finalize',
                         'release-gate', 'release-finalize', 'completed']) {
      const r = checkInvariants({ current_phase: phase },
        { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      assert.ok(
        r.violations.some((v) => v.id === VIOLATION_IDS.FAST_TRACK_PHASE0_ARTIFACTS_MISSING),
        `I13 must fire for phase=${phase} without artifacts`
      );
    }
  });

  it('Phase 0, planning phases, and pre-sprint lifecycle markers are exempt', () => {
    // codex r7 on PR #222: phase1b-plan is the phase that PRODUCES
    // contracts via decomposition, so it cannot be gated on contracts
    // already being present (chicken-and-egg). It's exempt along with
    // mpl-init / mpl-ambiguity-resolve / mpl-decompose / phase1-plan /
    // phase1a-research.
    for (const phase of ['mpl-init', 'mpl-ambiguity-resolve', 'mpl-decompose',
                         'phase1-plan', 'phase1a-research', 'phase1b-plan']) {
      const r = checkInvariants({ current_phase: phase },
        { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
      assert.ok(
        !r.violations.some((v) => v.id === VIOLATION_IDS.FAST_TRACK_PHASE0_ARTIFACTS_MISSING),
        `I13 must NOT fire for phase=${phase} (Phase 0 itself produces the artifacts)`
      );
    }
  });

  it('contracts/_no-boundaries.json alone satisfies the contracts requirement (simple/non-boundary tasks)', () => {
    // Operator opted out of cross-layer boundaries by writing only _no-boundaries.json.
    mkdirSync(join(tmp, '.mpl', 'mpl', 'phase0'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phase0', 'raw-scan.md'), '# raw scan');
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'), 'goal: simple\n');
    mkdirSync(join(tmp, '.mpl', 'contracts'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'contracts', '_no-boundaries.json'), '{}');
    const r = checkInvariants({ current_phase: 'phase2-sprint' },
      { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.FAST_TRACK_PHASE0_ARTIFACTS_MISSING));
  });

  it('STOP trigger is not the right surface — only STATE_WRITE fires this', () => {
    // Phase-controller's Stop logic is the legitimate transition writer.
    // I13 fires on the state-write BEFORE the transition lands.
    const r = checkInvariants({ current_phase: 'phase2-sprint' },
      { cwd: tmp, trigger: TRIGGERS.STOP });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.FAST_TRACK_PHASE0_ARTIFACTS_MISSING));
  });
});

describe('I7 current_phase folder lifecycle', () => {
  it('flags missing folder for concrete phase id', () => {
    const r = checkInvariants({ current_phase: 'phase-7' }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_LIFECYCLE));
  });
  it('passes when folder exists', () => {
    makePhaseFolders(3);
    const r = checkInvariants({ current_phase: 'phase-2' }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_LIFECYCLE));
  });
  it('lifecycle markers (phase2-sprint) are exempt', () => {
    const r = checkInvariants({ current_phase: 'phase2-sprint' }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_LIFECYCLE));
  });
});

describe('I8 schema_version range', () => {
  it('flags schema_version > CURRENT_SCHEMA_VERSION', () => {
    const r = checkInvariants({ schema_version: 99 }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.SCHEMA_VERSION_UNSUPPORTED));
  });
  it('matches current → ok', () => {
    const r = checkInvariants({ schema_version: SCHEMA_V }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.SCHEMA_VERSION_UNSUPPORTED));
  });
});

describe('I9 session_status enum', () => {
  it('flags unknown session_status', () => {
    const r = checkInvariants({ session_status: 'mystery_state' }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.SESSION_STATUS_INVALID));
  });
  for (const valid of [null, 'active', 'paused_budget', 'paused_checkpoint', 'verification_hang', 'blocked_hook', 'cancelled']) {
    it(`accepts ${valid === null ? 'null' : valid}`, () => {
      const r = checkInvariants({ session_status: valid }, { cwd: tmp });
      assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.SESSION_STATUS_INVALID));
    });
  }
});

describe('I10 completion execution freshness', () => {
  it('flags completed pipelines whose execution accounting stayed at defaults', () => {
    const r = checkInvariants({
      current_phase: 'completed',
      finalize_done: true,
      execution: {
        status: null,
        phases: { total: 0, completed: 0, current: null },
      },
    }, { cwd: tmp });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.COMPLETION_EXECUTION_STALE);
    assert.ok(v);
    assert.ok(v.issues.includes('execution.phases.total<=0_or_missing'));
    assert.ok(v.issues.includes('execution.phases.completed<=0_or_missing'));
    assert.ok(v.issues.includes('execution.status_not_completed'));
  });

  it('flags finalize_done writes that still point at an active phase id', () => {
    const r = checkInvariants({
      current_phase: 'phase5-finalize',
      finalize_done: true,
      execution: {
        status: 'completed',
        phases: { total: 2, completed: 2, current: 'phase-2' },
      },
    }, { cwd: tmp });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.COMPLETION_EXECUTION_STALE);
    assert.ok(v);
    assert.ok(v.issues.includes('execution.phases.current_not_null_at_completion'));
  });

  it('accepts fresh completion accounting', () => {
    const r = checkInvariants({
      current_phase: 'completed',
      finalize_done: true,
      execution: {
        status: 'completed',
        phases: { total: 2, completed: 2, current: null },
      },
    }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.COMPLETION_EXECUTION_STALE));
  });
});

describe('I11 blocked_hook companion fields', () => {
  it('flags blocked_hook with no active reason/instruction', () => {
    const r = checkInvariants({
      session_status: 'blocked_hook',
      blocked_by_hook: 'mpl-require-test-agent',
      blocked_phase: 'phase-1',
      blocked_artifact: 'state.test_agent_dispatched.phase-1',
      block_code: 'missing_or_invalid_test_agent_evidence',
      block_reason: null,
      resume_instruction: '',
      retry_context: { phase_id: 'phase-1' },
      blocked_at: '2026-05-19T00:00:00Z',
    }, { cwd: tmp });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.BLOCKED_HOOK_STALE);
    assert.ok(v);
    assert.deepStrictEqual(v.missing.sort(), ['block_reason', 'resume_instruction']);
  });

  it('requires artifact, code, and structured retry context', () => {
    const r = checkInvariants({
      session_status: 'blocked_hook',
      blocked_by_hook: 'mpl-baseline-guard',
      blocked_phase: 'mpl-ambiguity-resolve',
      block_reason: 'baseline is immutable',
      resume_instruction: 'create renewal sentinel and retry',
      blocked_at: '2026-05-19T00:00:00Z',
    }, { cwd: tmp });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.BLOCKED_HOOK_STALE);
    assert.ok(v);
    assert.deepStrictEqual(v.missing.sort(), ['block_code', 'blocked_artifact', 'retry_context']);
  });

  it('accepts a fully actionable blocked_hook state', () => {
    const r = checkInvariants({
      session_status: 'blocked_hook',
      blocked_by_hook: 'mpl-require-test-agent',
      blocked_phase: 'phase-1',
      blocked_artifact: 'state.test_agent_dispatched.phase-1',
      block_code: 'missing_or_invalid_test_agent_evidence',
      block_reason: 'missing test-agent dispatch',
      resume_instruction: 'dispatch mpl-test-agent for phase-1',
      retry_context: { phase_id: 'phase-1' },
      blocked_at: '2026-05-19T00:00:00Z',
    }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.BLOCKED_HOOK_STALE));
  });
});

describe('Multi-violation aggregation (exp15 4-way desync)', () => {
  it('surfaces 4 simultaneous violations', () => {
    // Realistic desync — I1 (paused+finalize), I4 (folder mismatch), I5
    // (count vs history), I7 (current_phase names a folder that doesn't
    // exist). I1 and I2 are mutually exclusive on the finalize_done field,
    // so this fixture picks the I1 branch.
    makePhaseFolders(2);
    const r = checkInvariants({
      schema_version: SCHEMA_V,
      session_status: 'paused_budget',
      finalize_done: true,                       // I1
      current_phase: 'phase-7',                  // I7 (no phase-7 folder)
      execution: { phases: { completed: 5 } },   // I4 (5 vs 2 on disk)
      fix_loop_count: 10,
      fix_loop_history: [{ phase: 'p1', count: 1 }], // I5 (10 vs 1)
    }, { cwd: tmp });
    const ids = r.violations.map((v) => v.id);
    assert.ok(ids.includes(VIOLATION_IDS.PAUSED_BUT_FINALIZED));
    assert.ok(ids.includes(VIOLATION_IDS.PHASE_FOLDER_MISMATCH));
    assert.ok(ids.includes(VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
    assert.ok(ids.includes(VIOLATION_IDS.PHASE_FOLDER_LIFECYCLE));
    assert.ok(r.violations.length >= 4);
  });
});

describe('formatViolations', () => {
  it('returns empty string when ok', () => {
    assert.strictEqual(formatViolations({ ok: true, violations: [] }), '');
  });
  it('lists ids in summary', () => {
    const text = formatViolations({
      ok: false,
      violations: [
        { id: 'I1', message: 'x' },
        { id: 'I4', message: 'y' },
      ],
    });
    assert.match(text, /\[MPL G3\]/);
    assert.match(text, /I1, I4/);
  });
});

/* ────────────────────────── hook integration ──────────────────────────── */

describe('mpl-state-invariant hook integration', () => {
  function runHook(eventName, toolName, toolInput = {}, extraState = null) {
    if (extraState) withState(extraState);
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: eventName,
      tool_name: toolName,
      tool_input: toolInput,
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    return JSON.parse(out);
  }

  it('clean state → silent', () => {
    const r = runHook('Stop', null, {}, { current_phase: 'phase2-sprint', schema_version: SCHEMA_V });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('I1 violation under default policy (warn) → systemMessage', () => {
    const r = runHook('Stop', null, {}, {
      current_phase: 'phase2-sprint',
      session_status: 'paused_budget',
      finalize_done: true,
    });
    assert.strictEqual(r.continue, true);
    assert.match(r.systemMessage, /\[MPL G3\]/);
    assert.match(r.systemMessage, /I1/);
  });

  it('strict mode → block', () => {
    const r = runHook('Stop', null, {}, {
      current_phase: 'phase2-sprint',
      session_status: 'paused_budget',
      finalize_done: true,
      enforcement: { strict: true },
    });
    assert.strictEqual(r.decision, 'block');
    assert.match(r.reason, /I1/);
  });

  it('off opt-out → silent even with violations', () => {
    writeFileSync(
      join(tmp, '.mpl', 'config.json'),
      JSON.stringify({ enforcement: { state_invariant_violation: 'off' } }),
    );
    const r = runHook('Stop', null, {}, {
      current_phase: 'completed',
      finalize_done: false,
    });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('PreToolUse Task with paused_budget → I3 surfaced', () => {
    const r = runHook('PreToolUse', 'Task', {}, {
      current_phase: 'phase2-sprint',
      session_status: 'paused_budget',
    });
    assert.match(r.systemMessage || r.reason || '', /I3/);
  });

  it('PreToolUse Edit on unrelated file → silent (state.json filter)', () => {
    const r = runHook('PreToolUse', 'Edit',
      { file_path: '/tmp/foo.ts', old_string: 'x', new_string: 'y' },
      { current_phase: 'phase3-gate', gate_results: {} },
    );
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('PreToolUse Edit on .mpl/state.json with phase3-gate missing evidence → I6 surfaced', () => {
    const stateJsonPath = join(tmp, '.mpl', 'state.json');
    const r = runHook('PreToolUse', 'Edit',
      { file_path: stateJsonPath, old_string: 'x', new_string: 'y' },
      { current_phase: 'phase3-gate', gate_results: {} },
    );
    assert.match(r.systemMessage || r.reason || '', /I6/);
  });

  it('PR #128 review #2: PreToolUse Write that strips structured evidence → I6 surfaced (proposed state simulation)', () => {
    // Pre-write state HAS structured evidence; the Write replaces it with
    // legacy-booleans only. The hook must validate the PROPOSED state, not
    // the current on-disk state, otherwise the strip-down silently passes.
    const stateJsonPath = join(tmp, '.mpl', 'state.json');
    const ent = (e) => ({ command: 'npm test', exit_code: e, stdout_tail: '', timestamp: 'now' });
    const cleanState = {
      schema_version: SCHEMA_V,
      current_phase: 'phase3-gate',
      gate_results: {
        hard1_baseline: ent(0),
        hard2_coverage: ent(0),
        hard3_resilience: ent(0),
      },
    };
    writeFileSync(stateJsonPath, JSON.stringify(cleanState));
    const proposedDirty = {
      schema_version: SCHEMA_V,
      current_phase: 'phase3-gate',
      gate_results: { hard1_passed: true, hard2_passed: true, hard3_passed: true },
    };
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: stateJsonPath, content: JSON.stringify(proposedDirty) },
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    const r = JSON.parse(out);
    assert.match(r.systemMessage || r.reason || '', /I6/);
  });

  it('PR #128 review #2: PreToolUse Edit that swaps structured for legacy → I6 surfaced', () => {
    const stateJsonPath = join(tmp, '.mpl', 'state.json');
    const ent = (e) => ({ command: 'npm test', exit_code: e, stdout_tail: '', timestamp: 'now' });
    const cleanState = {
      schema_version: SCHEMA_V,
      current_phase: 'phase3-gate',
      gate_results: {
        hard1_baseline: ent(0),
        hard2_coverage: ent(0),
        hard3_resilience: ent(0),
      },
    };
    const cleanText = JSON.stringify(cleanState);
    writeFileSync(stateJsonPath, cleanText);
    const dirtyText = JSON.stringify({
      schema_version: SCHEMA_V,
      current_phase: 'phase3-gate',
      gate_results: { hard1_passed: true, hard2_passed: true, hard3_passed: true },
    });
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: stateJsonPath, old_string: cleanText, new_string: dirtyText },
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    const r = JSON.parse(out);
    assert.match(r.systemMessage || r.reason || '', /I6/);
  });

  it('Write that ADDS structured evidence (clean transition) → silent, no I6', () => {
    // Inverse case: a Write that introduces structured evidence to a state
    // that previously had none should NOT surface I6 (or I12, or I13).
    const stateJsonPath = join(tmp, '.mpl', 'state.json');
    const ent = (cmd, e) => ({ command: cmd, exit_code: e, stdout_tail: '', timestamp: 'now' });
    // Seed Phase 0 artifacts so I13 doesn't trip on the phase3-gate
    // transition (#210).
    mkdirSync(join(tmp, '.mpl', 'mpl', 'phase0'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phase0', 'raw-scan.md'), '# raw scan');
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'), 'goal: test\n');
    mkdirSync(join(tmp, '.mpl', 'contracts'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'contracts', '_no-boundaries.json'),
      JSON.stringify({ boundary_id: '_no-boundaries' }));
    writeFileSync(stateJsonPath, JSON.stringify({
      schema_version: SCHEMA_V,
      current_phase: 'phase3-gate',
      gate_results: {},
    }));
    const proposedClean = {
      schema_version: SCHEMA_V,
      current_phase: 'phase3-gate',
      gate_results: {
        hard1_baseline: ent('npm run build', 0),
        hard2_coverage: ent('npm test', 0),
        hard3_resilience: ent('npx playwright test', 0),
      },
    };
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: stateJsonPath, content: JSON.stringify(proposedClean) },
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    const r = JSON.parse(out);
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('MPL not active → silent', () => {
    rmSync(join(tmp, '.mpl'), { recursive: true });
    const r = runHook('Stop', null, {});
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('I13 under default (warn) policy still blocks manual protected-phase writes (codex r4)', () => {
    // Codex r4 on PR #222 [data-integrity]: default state_invariant_violation
    // is `warn`, which would let a manual Write to state.json land a
    // protected phase without Phase 0 artifacts. I13 must override that
    // and always emit `decision: 'block'`.
    const stateJsonPath = join(tmp, '.mpl', 'state.json');
    writeFileSync(stateJsonPath, JSON.stringify({
      schema_version: SCHEMA_V,
      current_phase: 'phase2-sprint',
    }));
    // Note: no .mpl/mpl/phase0/* / .mpl/contracts/ artifacts seeded.
    const proposed = {
      schema_version: SCHEMA_V,
      current_phase: 'phase3-gate',
    };
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: stateJsonPath, content: JSON.stringify(proposed) },
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    const r = JSON.parse(out);
    assert.equal(r.decision, 'block',
      'I13 must produce decision:block even under default warn policy');
    assert.match(r.reason || '', /I13/);
    assert.match(r.reason || '', /raw-scan\.md|design-intent\.yaml|\.mpl\/contracts/);
  });
});
