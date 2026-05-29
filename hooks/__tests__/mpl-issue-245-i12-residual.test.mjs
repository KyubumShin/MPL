/**
 * #245 — Residual I12 forgery surface from PR #244.
 *
 * AC coverage:
 *   (1) Trailing keyword arg promotes the entry to hard3: fixed by
 *       picking the family from the subcommand, not the whole canonical.
 *       `npm test playwright` → hard2 (not hard3).
 *   (2) Subshell expansion (`$( … )`, backticks, `<( … )`, `>( … )`)
 *       embedded a separate command whose keyword forged hard3.
 *       Fixed by cutting at the opener in `stripNonExecutedSuffix`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGateCommand } from '../lib/mpl-gate-classify.mjs';

// ---------------------------------------------------------------------------
// (1) Trailing keyword arg → family from subcommand, not whole canonical
// ---------------------------------------------------------------------------

test('#245 (1) [data-integrity]: `npm test playwright` classifies as hard2, not hard3', () => {
  assert.equal(classifyGateCommand('npm test playwright'), 'hard2_coverage');
});

test('#245 (1) [data-integrity]: family resolves from subcommand for every npm-family head', () => {
  for (const head of ['npm', 'pnpm', 'yarn']) {
    assert.equal(
      classifyGateCommand(`${head} test playwright`),
      'hard2_coverage',
      `${head} test playwright must be hard2`,
    );
    assert.equal(
      classifyGateCommand(`${head} test e2e`),
      'hard2_coverage',
      `${head} test e2e must be hard2 (positional arg, not script)`,
    );
    assert.equal(
      classifyGateCommand(`${head} test cypress wdio contract`),
      'hard2_coverage',
      `${head} test with multiple HARD3 keywords as positional args must be hard2`,
    );
  }
});

test('#245 (1) [data-integrity]: cargo/go trailing keyword args do not promote', () => {
  assert.equal(classifyGateCommand('cargo test playwright'), 'hard2_coverage');
  assert.equal(classifyGateCommand('cargo build playwright'), 'hard1_baseline');
  assert.equal(classifyGateCommand('go test e2e'), 'hard2_coverage');
  assert.equal(classifyGateCommand('go build e2e'), 'hard1_baseline');
  assert.equal(classifyGateCommand('go vet playwright'), 'hard1_baseline');
});

test('#245 (1): npm run X still classifies by the script name (X), not whole canonical', () => {
  // `npm run e2e` is the legitimate hard3 form — script name IS the
  // family signal. The fix must preserve this.
  assert.equal(classifyGateCommand('npm run e2e'), 'hard3_resilience');
  assert.equal(classifyGateCommand('pnpm run cypress'), 'hard3_resilience');
  // `npm run lint` / `npm run build` resolve normally.
  assert.equal(classifyGateCommand('npm run lint'), 'hard1_baseline');
  assert.equal(classifyGateCommand('pnpm run build'), 'hard1_baseline');
  // `npm run test` is the test script.
  assert.equal(classifyGateCommand('npm run test'), 'hard2_coverage');
});

test('#245 (1): bare subcommand without args still resolves to the correct family', () => {
  assert.equal(classifyGateCommand('npm test'), 'hard2_coverage');
  assert.equal(classifyGateCommand('npm lint'), 'hard1_baseline');
  assert.equal(classifyGateCommand('npm build'), 'hard1_baseline');
  assert.equal(classifyGateCommand('cargo test'), 'hard2_coverage');
  assert.equal(classifyGateCommand('cargo clippy'), 'hard1_baseline');
  assert.equal(classifyGateCommand('go test'), 'hard2_coverage');
  assert.equal(classifyGateCommand('go build'), 'hard1_baseline');
});

test('#245 (1): npx with non-runner first positional still rejects (unchanged)', () => {
  // The runner head check is still strict — `npx cowsay playwright`
  // doesn't classify because cowsay isn't a runner script.
  assert.equal(classifyGateCommand('npx cowsay playwright'), null);
});

test('#245 (1): npx with runner script positional classifies normally (unchanged)', () => {
  assert.equal(classifyGateCommand('npx playwright test'), 'hard3_resilience');
  assert.equal(classifyGateCommand('npx jest'), 'hard2_coverage');
  assert.equal(classifyGateCommand('npx eslint .'), 'hard1_baseline');
});

// ---------------------------------------------------------------------------
// (2) Subshell expansion stripped before family regex
// ---------------------------------------------------------------------------

test('#245 (2) [data-integrity]: $(...) subshell expansion does not promote hard tier', () => {
  assert.equal(
    classifyGateCommand('npm test $(echo playwright)'),
    'hard2_coverage',
    'subshell argument output must not match HARD3 keyword',
  );
  assert.equal(
    classifyGateCommand('cargo build $(echo e2e)'),
    'hard1_baseline',
  );
});

test('#245 (2) [data-integrity]: backtick command substitution does not promote hard tier', () => {
  assert.equal(
    classifyGateCommand('npm test `echo playwright`'),
    'hard2_coverage',
  );
  assert.equal(
    classifyGateCommand('go build `echo e2e`'),
    'hard1_baseline',
  );
});

test('#245 (2) [data-integrity]: process substitution `<( … )` / `>( … )` does not promote', () => {
  assert.equal(
    classifyGateCommand('npm test <(echo playwright)'),
    'hard2_coverage',
  );
  assert.equal(
    classifyGateCommand('npm test >(echo cypress)'),
    'hard2_coverage',
  );
});

test('#245 (2): legitimate trailing `$` in a positional arg unaffected', () => {
  // `$` alone (no `(` following) is not a subshell opener. The strip
  // only cuts at `$(` specifically.
  assert.equal(classifyGateCommand('npm test $foo'), 'hard2_coverage');
});

test('#245 (1+2) combined: subshell + trailing positional do not promote', () => {
  // Belt and suspenders — both fixes apply on the same canonical.
  assert.equal(
    classifyGateCommand('npm test $(echo cypress) e2e wdio'),
    'hard2_coverage',
  );
});
