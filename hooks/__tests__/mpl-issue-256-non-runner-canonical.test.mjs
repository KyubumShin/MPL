/**
 * #256 — Residual I12 forgery surface for NON-RUNNER gate heads.
 *
 * PR #245 fixed the trailing-keyword shape for runner heads
 * (npm/pnpm/yarn/cargo/go via `classifyRunnerHead`). The structurally
 * same-class hole remained for the rest of `STRICT_GATE_HEAD_ALLOWLIST`:
 * heads whose binary name IS the family signal (tsc/eslint/vitest/jest/
 * mocha/ruff/mypy/playwright/cypress/wdio). Their fallback ran
 * `matchFamilyRegex(safeCanonical)` against the whole canonical, so a
 * trailing HARD3 keyword promoted the entry. ANSI-C `$'...'` and
 * parameter expansion `${...}` wrapped the same forgery into different
 * quoting forms.
 *
 * AC coverage:
 *   (A) Trailing positional keyword arg → family from the head itself.
 *       `tsc playwright` → hard1_baseline (not hard3_resilience).
 *   (B) Quote / expansion wrappers carry no signal.
 *       `tsc $'playwright'` → hard1_baseline.
 *       `tsc ${FOO}playwright` → hard1_baseline.
 *       `eslint $"cypress"` → hard1_baseline.
 *
 * The fix synthesizes a canonical of just the head before
 * `matchFamilyRegex` for the head-as-signal set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGateCommand } from '../lib/mpl-gate-classify.mjs';

// ---------------------------------------------------------------------------
// (A) Trailing keyword arg on non-runner heads
// ---------------------------------------------------------------------------

test('#256 (A) [data-integrity]: `tsc playwright` classifies as hard1_baseline, not hard3_resilience', () => {
  assert.equal(classifyGateCommand('tsc playwright'), 'hard1_baseline');
});

test('#256 (A) [data-integrity]: `eslint cypress` classifies as hard1_baseline, not hard3_resilience', () => {
  assert.equal(classifyGateCommand('eslint cypress'), 'hard1_baseline');
});

test('#256 (A) [data-integrity]: `vitest playwright` classifies as hard2_coverage, not hard3_resilience', () => {
  assert.equal(classifyGateCommand('vitest playwright'), 'hard2_coverage');
});

test('#256 (A) [data-integrity]: `jest cypress` classifies as hard2_coverage, not hard3_resilience', () => {
  assert.equal(classifyGateCommand('jest cypress'), 'hard2_coverage');
});

test('#256 (A) [data-integrity]: `mocha e2e` classifies as hard2_coverage, not hard3_resilience', () => {
  assert.equal(classifyGateCommand('mocha e2e'), 'hard2_coverage');
});

test('#256 (A): every head-as-signal binary rejects HARD3 keyword leakage', () => {
  // Each head's positional arg may contain a foreign-family keyword
  // (file path, test selector, plugin name). The head's family must
  // win regardless of the arg.
  const cases = [
    // Hard 1
    ['tsc', 'hard1_baseline'],
    ['eslint', 'hard1_baseline'],
    ['ruff', 'hard1_baseline'],
    ['mypy', 'hard1_baseline'],
    // Hard 2
    ['vitest', 'hard2_coverage'],
    ['jest', 'hard2_coverage'],
    ['pytest', 'hard2_coverage'],
    ['mocha', 'hard2_coverage'],
    // Hard 3 (head is the e2e runner itself — trailing args still ignored)
    ['playwright', 'hard3_resilience'],
    ['cypress', 'hard3_resilience'],
    ['wdio', 'hard3_resilience'],
  ];
  for (const [head, expected] of cases) {
    // Trailing arg with a HARD3 keyword that does NOT belong to this head.
    assert.equal(
      classifyGateCommand(`${head} playwright`),
      expected,
      `${head} playwright must be ${expected}, not hard3 via trailing keyword`,
    );
    // Trailing arg with hard2 keyword.
    assert.equal(
      classifyGateCommand(`${head} jest`),
      expected,
      `${head} jest must be ${expected}, not hard2 via trailing keyword`,
    );
  }
});

// ---------------------------------------------------------------------------
// (B) ANSI-C quoting + parameter expansion + locale translation
// ---------------------------------------------------------------------------

test("#256 (B) [data-integrity]: `tsc $'playwright'` (ANSI-C) classifies as hard1_baseline", () => {
  assert.equal(classifyGateCommand("tsc $'playwright'"), 'hard1_baseline');
});

test('#256 (B) [data-integrity]: `tsc ${FOO}playwright` (parameter expansion) classifies as hard1_baseline', () => {
  assert.equal(classifyGateCommand('tsc ${FOO}playwright'), 'hard1_baseline');
});

test('#256 (B) [data-integrity]: `eslint $"cypress"` (locale translation) classifies as hard1_baseline', () => {
  assert.equal(classifyGateCommand('eslint $"cypress"'), 'hard1_baseline');
});

test('#256 (B): every head-as-signal binary survives ANSI-C / parameter-expansion wrapping of HARD3 keywords', () => {
  const wrappers = [
    (kw) => `$'${kw}'`,           // ANSI-C
    (kw) => `\${FOO}${kw}`,       // parameter expansion (literal $ in source)
    (kw) => `$"${kw}"`,           // locale translation
    (kw) => `'${kw}'`,            // single-quoted
    (kw) => `"${kw}"`,            // double-quoted
  ];
  const cases = [
    ['tsc', 'hard1_baseline'],
    ['eslint', 'hard1_baseline'],
    ['vitest', 'hard2_coverage'],
    ['jest', 'hard2_coverage'],
  ];
  for (const [head, expected] of cases) {
    for (const wrap of wrappers) {
      const cmd = `${head} ${wrap('playwright')}`;
      assert.equal(
        classifyGateCommand(cmd),
        expected,
        `${cmd} must be ${expected}, not hard3 via wrapper-quoted keyword`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Regression — legitimate invocations still classify correctly
// ---------------------------------------------------------------------------

test('#256 regression: bare head invocations stay correctly classified', () => {
  assert.equal(classifyGateCommand('tsc'), 'hard1_baseline');
  assert.equal(classifyGateCommand('eslint'), 'hard1_baseline');
  assert.equal(classifyGateCommand('vitest'), 'hard2_coverage');
  assert.equal(classifyGateCommand('jest'), 'hard2_coverage');
  assert.equal(classifyGateCommand('mocha'), 'hard2_coverage');
  assert.equal(classifyGateCommand('pytest'), 'hard2_coverage');
  assert.equal(classifyGateCommand('playwright'), 'hard3_resilience');
  assert.equal(classifyGateCommand('cypress'), 'hard3_resilience');
});

test('#256 regression: head with config-file arg classifies by the head, not by the arg path', () => {
  // `tsc -p tsconfig.json` and `eslint src/` are the everyday legit
  // shapes — they must still classify by the head.
  assert.equal(classifyGateCommand('tsc -p tsconfig.json'), 'hard1_baseline');
  assert.equal(classifyGateCommand('eslint src/'), 'hard1_baseline');
  assert.equal(classifyGateCommand('vitest run'), 'hard2_coverage');
  assert.equal(classifyGateCommand('jest --ci'), 'hard2_coverage');
  assert.equal(classifyGateCommand('mocha test/foo.spec.js'), 'hard2_coverage');
  assert.equal(classifyGateCommand('playwright test'), 'hard3_resilience');
});

test('#256 regression: #244 / #245 runner-head behavior is preserved', () => {
  // The fix touches only the non-runner fall-through; runner heads
  // (npm/pnpm/yarn/cargo/go/npx/pnpx) still route through
  // classifyRunnerHead. Spot-check the prior invariants.
  assert.equal(classifyGateCommand('npm test playwright'), 'hard2_coverage');
  assert.equal(classifyGateCommand('npm run e2e'), 'hard3_resilience');
  assert.equal(classifyGateCommand('cargo test playwright'), 'hard2_coverage');
  assert.equal(classifyGateCommand('npx playwright test'), 'hard3_resilience');
  assert.equal(classifyGateCommand('npx cowsay playwright'), null);
});

test('#256 regression: unrecognized heads still return null', () => {
  // Heads not in the allowlist remain unclassified, regardless of any
  // trailing keyword.
  assert.equal(classifyGateCommand('biome playwright'), null);
  assert.equal(classifyGateCommand('deno playwright'), null);
  assert.equal(classifyGateCommand('bun playwright'), null);
});
