/**
 * exp25 #236 A3 — read-only allowlist fast-exit (false-positive fix).
 *
 * The protected-path destructive guard (matchesProtectedDelete) used an
 * over-broad isDestructive heuristic (any `sed`/`awk`/interpreter mention or any
 * redirect) + a substring `.includes(target)` match, so READ-ONLY commands that
 * merely NAMED a protected path were blocked — 4× in one analysis session
 * (thin-harness-visual.html §7). isReadOnlyPipeline() now exits early for
 * read-only command FORMS; any mutation signal falls through to the full
 * analysis, so destructive commands STILL block (no security regression — the
 * 61-case mpl-issue-236-write-guard-tighten suite stays green).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesProtectedDelete, isReadOnlyPipeline } from '../lib/policy/source-edit.mjs';

const cwd = '/tmp/mpl-a3-test';

/* ─────────────── false positives now FIXED (return null) ─────────────── */

const READONLY_FALSE_POSITIVES = [
  "sed -n '1,80p' .mpl/mpl/config.mjs | grep loadConfig",       // §7 #1
  'ls docs/learnings',                                           // §7 #2
  'grep -rn "model tier" .mpl/mpl',                             // §7 #3
  'cat .mpl/contracts/boundary.json | grep -n "\\.mpl"',       // §7 #4
  'cd .mpl/mpl/0.19.0/hooks && sed -n 1,40p config.mjs | grep mpl', // cd && sed | grep
  'grep -rn "decomposition" .mpl/mpl 2>/dev/null',             // /dev/null redirect is harmless
  'head -50 docs/learnings/notes.md',
  'wc -l .mpl/memory/*.md',
  'diff .mpl/contracts/a.json .mpl/contracts/b.json',
];

for (const command of READONLY_FALSE_POSITIVES) {
  test(`read-only is allowed: ${command.slice(0, 56)}`, () => {
    assert.equal(isReadOnlyPipeline(command), true, 'should classify as read-only');
    assert.equal(matchesProtectedDelete(command, cwd), null, 'must NOT block a read-only command');
  });
}

/* ─────────────── destructive STILL blocks (no regression) ─────────────── */

const DESTRUCTIVE_STILL_BLOCKS = [
  'rm -rf .mpl/mpl',
  'mv .mpl/contracts /tmp/x',
  'sed -i "s/a/b/" .mpl/mpl/decomposition.yaml',                // sed -i = write
  'echo hacked > .mpl/mpl/state',                               // real redirect write
  'tee .mpl/contracts/x.json < /dev/null',
  'python3 -c "import shutil; shutil.rmtree(\'.mpl/mpl\')"',    // opaque interpreter
  'rm -rf $(printf .mpl/contracts | base64 -d)',               // cmd-sub + decoder
  'find .mpl/memory -delete',
  'dd if=/dev/zero of=.mpl/mpl/decomposition.yaml',
];

for (const command of DESTRUCTIVE_STILL_BLOCKS) {
  test(`destructive still blocks: ${command.slice(0, 56)}`, () => {
    assert.equal(isReadOnlyPipeline(command), false, 'must NOT be classified read-only');
    assert.notEqual(matchesProtectedDelete(command, cwd), null, 'destructive command must still be caught');
  });
}

/* ─────────────── isReadOnlyPipeline unit edges ─────────────── */

test('a real file redirect (not /dev/null) is not read-only', () => {
  assert.equal(isReadOnlyPipeline('grep x file > out.txt'), false);
});
test('command substitution is not read-only', () => {
  assert.equal(isReadOnlyPipeline('cat $(find . -name x)'), false);
});
test('a non-allowlisted head (awk) is not read-only (stays opaque)', () => {
  assert.equal(isReadOnlyPipeline('awk "{print}" .mpl/mpl/x'), false);
});
test('empty / non-string → not read-only', () => {
  assert.equal(isReadOnlyPipeline(''), false);
  assert.equal(isReadOnlyPipeline(null), false);
});
