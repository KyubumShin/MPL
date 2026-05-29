import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { blockedPhaseTransitionReason } from '../lib/mpl-phase0-artifacts.mjs';
import { checkInvariants, TRIGGERS } from '../lib/mpl-state-invariant.mjs';
import { validateArtifactFile } from '../lib/mpl-artifact-schema.mjs';
import {
  classifyGateCommand,
  STRICT_GATE_HEAD_ALLOWLIST,
  allowedGateHeads,
} from '../lib/mpl-gate-classify.mjs';
import { decideTimeout } from '../lib/bash-timeout-categories.mjs';
import { loadConfig } from '../lib/mpl-config.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-issue-240-'));
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeConfig(cfg) {
  writeFileSync(join(tmp, '.mpl', 'config.json'), JSON.stringify(cfg, null, 2));
}

/* ──────────────────── A1 phase0_artifacts_required ──────────────────── */

describe('#240 A1: phase0_artifacts_required config knob', () => {
  it('default true: missing phase 0 artifacts block a protected-phase transition', () => {
    const reason = blockedPhaseTransitionReason(tmp, 'phase2-sprint');
    assert.match(reason, /Phase 0 boundary\/runtime artifacts missing/);
  });

  it('phase0_artifacts_required=false: protected-phase transition passes', () => {
    writeConfig({ phase0_artifacts_required: false });
    const reason = blockedPhaseTransitionReason(tmp, 'phase2-sprint');
    assert.equal(reason, null);
  });

  it('phase0_artifacts_required=false: exempt phase still passes (no change)', () => {
    writeConfig({ phase0_artifacts_required: false });
    const reason = blockedPhaseTransitionReason(tmp, 'phase1b-plan');
    assert.equal(reason, null);
  });

  it('codex/claude r3 [contract-break]: I13 (state-invariant) ALSO honors phase0_artifacts_required=false', () => {
    // Claude r2/r3 on PR #244: A1 was honored at the controller boundary
    // (blockedPhaseTransitionReason) but NOT at I13 in mpl-state-invariant.
    // After the controller lets the transition through, the next
    // mpl_state_write in a protected phase fired I13 → block. The knob
    // must short-circuit BOTH paths.
    writeConfig({ phase0_artifacts_required: false });
    const { violations } = checkInvariants(
      { current_phase: 'phase2-sprint' },
      { cwd: tmp, trigger: TRIGGERS.STATE_WRITE },
    );
    const i13 = violations.find((vio) => vio.id === 'I13');
    assert.equal(i13, undefined, 'I13 must not fire when phase0_artifacts_required=false');
  });

  it('codex/claude r3: I13 still fires when phase0_artifacts_required is default (true)', () => {
    const { violations } = checkInvariants(
      { current_phase: 'phase2-sprint' },
      { cwd: tmp, trigger: TRIGGERS.STATE_WRITE },
    );
    const i13 = violations.find((vio) => vio.id === 'I13');
    assert.ok(i13, 'I13 must still fire by default');
  });

  it('phase0_artifacts_required=true (explicit): same as default', () => {
    writeConfig({ phase0_artifacts_required: true });
    const reason = blockedPhaseTransitionReason(tmp, 'phase2-sprint');
    assert.match(reason, /Phase 0 boundary\/runtime artifacts missing/);
  });
});

/* ──────────────────── A2 test_agent.default_required ──────────────────── */

describe('#240 A2: test_agent.default_required config knob', () => {
  it('default config carries test_agent.default_required: true', () => {
    const cfg = loadConfig(tmp);
    assert.equal(cfg.test_agent.default_required, true);
  });

  it('test_agent.default_required can be opted out via config', () => {
    writeConfig({ test_agent: { default_required: false } });
    const cfg = loadConfig(tmp);
    assert.equal(cfg.test_agent.default_required, false);
  });

  it('codex/claude r3 [contract-break]: artifact-schema honors test_agent.default_required', () => {
    // Claude r2 on PR #244: hand-written decomposition without
    // `test_agent_required` per phase was flagged by validateDecompositionContract
    // even when the workspace opted out via config. The schema check
    // must respect the same knob the runtime hook does.
    const decomposition = `goal_contract_hash: "abc"
phases:
  - id: phase-1
    scope: "task"
    covers: [UC-01]
    impact: { create: [], modify: [], affected_tests: [] }
    interface_contract: { requires: [], produces: [], contract_files: [] }
    success_criteria: []
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: []
      ontology_entities: [api]
`;
    // Default: missing test_agent_required is a violation.
    const defaultVerdict = validateArtifactFile(
      '.mpl/mpl/decomposition.yaml',
      decomposition,
      { cwd: tmp },
    );
    assert.ok(
      defaultVerdict.missing.some((m) => m.includes('test_agent_required')),
      'default config flags missing test_agent_required',
    );

    // With opt-out: missing field passes.
    writeConfig({ test_agent: { default_required: false } });
    const optedOutVerdict = validateArtifactFile(
      '.mpl/mpl/decomposition.yaml',
      decomposition,
      { cwd: tmp },
    );
    assert.equal(
      optedOutVerdict.missing.some((m) => m.includes('test_agent_required')),
      false,
      'config opt-out passes artifact-schema',
    );
  });
});

/* ──────────────────── A3 ambiguity threshold ──────────────────── */

describe('#240 A3: ambiguity threshold + force-proceed config knobs', () => {
  it('default ambiguity threshold is 0.2', () => {
    const cfg = loadConfig(tmp);
    assert.equal(cfg.ambiguity.threshold, 0.2);
    assert.equal(cfg.ambiguity.force_proceed_after_rounds, null);
  });

  it('ambiguity.threshold can be raised in config', () => {
    writeConfig({ ambiguity: { threshold: 0.4 } });
    const cfg = loadConfig(tmp);
    assert.equal(cfg.ambiguity.threshold, 0.4);
  });

  it('ambiguity.force_proceed_after_rounds: N round count is configurable', () => {
    writeConfig({ ambiguity: { force_proceed_after_rounds: 3 } });
    const cfg = loadConfig(tmp);
    assert.equal(cfg.ambiguity.force_proceed_after_rounds, 3);
  });
});

/* ──────────────────── A4 gate_classify.allowed_heads ──────────────────── */

describe('#240 A4: gate_classify.allowed_heads config knob', () => {
  it('built-in STRICT_GATE_HEAD_ALLOWLIST stays the canonical reference set', () => {
    assert.ok(STRICT_GATE_HEAD_ALLOWLIST.has('npm'));
    assert.ok(STRICT_GATE_HEAD_ALLOWLIST.has('cargo'));
    // Bun is NOT in the built-in set by design.
    assert.equal(STRICT_GATE_HEAD_ALLOWLIST.has('bun'), false);
  });

  it('default workspace classifies `deno test` as null (deno not allowlisted)', () => {
    const family = classifyGateCommand('deno test', { cwd: tmp });
    assert.equal(family, null);
  });

  it('codex r1 [data-integrity]: interpreter heads in config are SILENTLY DROPPED (not allowlisted)', () => {
    // Codex r1 on PR #244: `.mpl/config.json` extension cannot
    // admit `node` / `python` / `ruby` / etc. — script interpreters
    // take arbitrary text via `-e` / `-c` and would let
    // `node -e "console.log('e2e')"` forge hard3 evidence.
    writeConfig({
      gate_classify: {
        allowed_heads: ['node', 'python', 'ruby', 'perl', 'awk', 'sed', 'lua', 'bun', 'deno'],
      },
    });
    const merged = allowedGateHeads(tmp);
    assert.equal(merged.has('node'), false, 'node interpreter must be denied');
    assert.equal(merged.has('python'), false);
    assert.equal(merged.has('ruby'), false);
    assert.equal(merged.has('perl'), false);
    assert.equal(merged.has('awk'), false);
    assert.equal(merged.has('bun'), false, 'bun CLI runtime can `eval` — denied');
    assert.equal(merged.has('deno'), false, 'deno CLI runtime can `eval` — denied');
    // node/python/etc. classification stays null even with the config
    // entry — the interpreter denylist is structurally enforced.
    assert.equal(classifyGateCommand('node -e "console.log(\'e2e\')"', { cwd: tmp }), null);
    assert.equal(classifyGateCommand('python -c "print(\'npm test\')"', { cwd: tmp }), null);
  });

  it('codex r1 [contract-break]: structured allowed_heads entries map heads to gate families', () => {
    // Codex r1 on PR #244: simple string allowed_heads (`["deno"]`)
    // passed the head check but family regex returned null, so the
    // config knob failed its purpose. Structured entries with
    // explicit `families` map are accepted and `classifyGateCommand`
    // resolves them.
    writeConfig({
      gate_classify: {
        allowed_heads: [
          {
            head: 'deno',
            families: {
              hard1_baseline: ['check', 'lint', 'fmt'],
              hard2_coverage: ['test'],
              hard3_resilience: ['bench'],
            },
          },
          {
            head: 'biome',
            families: {
              hard1_baseline: ['check', 'lint', 'ci'],
            },
          },
        ],
      },
    });
    assert.equal(classifyGateCommand('deno test', { cwd: tmp }), 'hard2_coverage');
    assert.equal(classifyGateCommand('deno check src/', { cwd: tmp }), 'hard1_baseline');
    assert.equal(classifyGateCommand('deno bench', { cwd: tmp }), 'hard3_resilience');
    assert.equal(classifyGateCommand('biome ci', { cwd: tmp }), 'hard1_baseline');
    // `biome` head with no matching sub-command → null.
    assert.equal(classifyGateCommand('biome unknown', { cwd: tmp }), null);
  });

  it('codex r1 [data-integrity]: structured entry with interpreter head — flag check blocks -e/-c abuse', () => {
    // Structured entries CAN target interpreter heads (operators can
    // legitimately configure `deno test` / `bun test` / `node test`)
    // because the classifier requires the configured pattern to be
    // the IMMEDIATE next non-flag token after the head. `node -e
    // "console.log('e2e')"` fails because `-e` comes first.
    writeConfig({
      gate_classify: {
        allowed_heads: [
          { head: 'node', families: { hard2_coverage: ['test'] } },
          { head: 'deno', families: { hard2_coverage: ['test'] } },
        ],
      },
    });
    // Legitimate direct invocation: head + non-flag subcommand `test` → matches.
    assert.equal(classifyGateCommand('node test', { cwd: tmp }), 'hard2_coverage');
    assert.equal(classifyGateCommand('deno test', { cwd: tmp }), 'hard2_coverage');
    // Interpreter abuse via `-e` / `-c`: flag appears before any
    // pattern → classifyConfiguredHead returns null.
    assert.equal(classifyGateCommand('node -e "console.log(\'e2e\')"', { cwd: tmp }), null);
    assert.equal(classifyGateCommand('deno -e "console.log(\'playwright\')"', { cwd: tmp }), null);
    assert.equal(classifyGateCommand('node --eval "test"', { cwd: tmp }), null);
  });

  it('codex r1 [data-integrity]: STRING-form entry with interpreter head IS dropped (no flag guard)', () => {
    // String-form entries delegate fully to the built-in family
    // regex, which would match arbitrary `-e` / `-c` text — so the
    // interpreter denylist stays applied at the string-form path.
    writeConfig({
      gate_classify: { allowed_heads: ['node', 'python', 'ruby'] },
    });
    const merged = allowedGateHeads(tmp);
    assert.equal(merged.has('node'), false);
    assert.equal(merged.has('python'), false);
    assert.equal(merged.has('ruby'), false);
  });

  it('codex r2 [contract-break]: structured entry for BUILT-IN head does NOT shadow existing classifications', () => {
    // Codex r2 on PR #244: a structured entry like
    //   { head: 'npm', families: { hard2_coverage: ['test'] } }
    // would otherwise force structured-only classification for npm,
    // breaking `npm run lint` / `npm run build` (which the built-in
    // regex classifies as hard1_baseline). Built-in heads must
    // preserve their built-in classification as the fallback when
    // the structured pattern doesn't match.
    writeConfig({
      gate_classify: {
        allowed_heads: [
          { head: 'npm', families: { hard2_coverage: ['test'] } },
        ],
      },
    });
    // Structured pattern matches → uses structured family.
    assert.equal(classifyGateCommand('npm test', { cwd: tmp }), 'hard2_coverage');
    // Built-in regex preserved for non-structured sub-commands.
    assert.equal(classifyGateCommand('npm run lint', { cwd: tmp }), 'hard1_baseline');
    assert.equal(classifyGateCommand('npm run build', { cwd: tmp }), 'hard1_baseline');
    assert.equal(classifyGateCommand('npm run test:e2e', { cwd: tmp }), 'hard3_resilience');
  });

  it('codex r4 [contract-break]: eval-flag stripping applies on the DEFAULT path (no structured config)', () => {
    // codex r4: r3 only applied stripAtEvalFlag inside the structured
    // branch. The default no-config path still ran matchFamilyRegex
    // on the full canonical, so `npx -c "echo playwright"` classified
    // as hard3 even with no .mpl/config.json present. Must strip
    // before EVERY fallback regex call.
    // No writeConfig() — default workspace.
    assert.equal(classifyGateCommand('npx -c "echo playwright"', { cwd: tmp }), null);
    assert.equal(classifyGateCommand('npx --call "playwright test"', { cwd: tmp }), null);
    assert.equal(classifyGateCommand('npm run -c "echo playwright"', { cwd: tmp }), null);
    // Without cwd at all (built-in only, no config read) — same fix applies.
    assert.equal(classifyGateCommand('npx -c "echo playwright"'), null);
    // Legitimate `npx playwright test` still classifies (no eval flag).
    assert.equal(classifyGateCommand('npx playwright test', { cwd: tmp }), 'hard3_resilience');
  });

  it('codex r3 [contract-break]: built-in head with eval flag (`npx -c`) does NOT forge gate evidence', () => {
    // codex r3 on PR #244: r2 fallback to matchFamilyRegex for
    // built-in heads re-opened forgery. `npx -c "echo playwright"`
    // would match `\bplaywright\b` in the string literal.
    // Fix: strip canonical at first eval-shaped flag (-c, --call,
    // -e, --eval, etc.) before fallback regex.
    writeConfig({
      gate_classify: {
        allowed_heads: [
          { head: 'npx', families: { hard2_coverage: ['vitest'] } },
        ],
      },
    });
    // Structured pattern still works.
    assert.equal(classifyGateCommand('npx vitest', { cwd: tmp }), 'hard2_coverage');
    // Eval-flag with playwright keyword in string literal → null.
    assert.equal(classifyGateCommand('npx -c "echo playwright"', { cwd: tmp }), null);
    assert.equal(classifyGateCommand('npx --call "playwright test"', { cwd: tmp }), null);
    // Legitimate `npx playwright test` (no eval flag) still classifies via built-in regex.
    assert.equal(classifyGateCommand('npx playwright test', { cwd: tmp }), 'hard3_resilience');
  });

  it('codex r2: non-built-in head with structured entry stays structured-only (no regex fallback)', () => {
    // For non-built-in heads, structured-only is correct — falling
    // back to matchFamilyRegex would match keywords in string
    // literals (the interpreter abuse codex r1 caught).
    writeConfig({
      gate_classify: {
        allowed_heads: [
          { head: 'deno', families: { hard2_coverage: ['test'] } },
        ],
      },
    });
    // Structured match works.
    assert.equal(classifyGateCommand('deno test', { cwd: tmp }), 'hard2_coverage');
    // No structured match + no built-in regex fallback → null.
    assert.equal(classifyGateCommand('deno fmt', { cwd: tmp }), null);
    // Critical: no regex fallback means `deno -e "playwright"` cannot
    // forge hard3 evidence via string literal keywords.
    assert.equal(classifyGateCommand('deno -e "console.log(\'playwright\')"', { cwd: tmp }), null);
  });

  it('plain string allowed_heads still extend the head set (back-compat for non-interpreters)', () => {
    writeConfig({ gate_classify: { allowed_heads: ['gradlew', 'mvn'] } });
    const merged = allowedGateHeads(tmp);
    assert.ok(merged.has('gradlew'));
    assert.ok(merged.has('mvn'));
    // mvn test happens to also match the built-in family regex via
    // `\bmvn\s+test\b`-style patterns (not in current set, but the
    // head check passes regardless).
  });

  it('allowlist extension is case-normalized (lowercase)', () => {
    writeConfig({ gate_classify: { allowed_heads: ['GRADLEW', 'Mvn'] } });
    const merged = allowedGateHeads(tmp);
    assert.ok(merged.has('gradlew'));
    assert.ok(merged.has('mvn'));
  });

  it('classifyGateCommand without cwd uses built-in set only (back-compat)', () => {
    // Calling with no cwd preserves the old single-arg API behavior.
    // Bun is not built-in → null.
    const family = classifyGateCommand('bun test');
    assert.equal(family, null);
  });
});

/* ──────────────────── A5 bash_timeout overrides ──────────────────── */

describe('#240 A5: bash_timeout per-category max_ms config knob', () => {
  it('default vitest-jest ceiling is 300_000ms', () => {
    const d = decideTimeout('vitest run', 350_000);
    assert.equal(d.action, 'warn'); // exceeds 300_000 → warn (or block in strict)
  });

  it('config raises vitest-jest ceiling for monorepos', () => {
    const d = decideTimeout('vitest run', 350_000, {
      configOverride: { 'vitest-jest': { max_ms: 600_000 } },
    });
    assert.equal(d.action, 'silent', 'override raises ceiling so 350s is now ok');
  });

  it('config raises build ceiling for cargo release builds', () => {
    const d = decideTimeout('cargo build', 240_000, {
      configOverride: { build: { max_ms: 300_000 } },
    });
    assert.equal(d.action, 'silent');
  });

  it('config can also tighten the ceiling (operator policy)', () => {
    const d = decideTimeout('vitest run', 250_000, {
      configOverride: { 'vitest-jest': { max_ms: 200_000 } },
    });
    assert.equal(d.action, 'warn');
  });

  it('non-numeric / negative overrides are ignored (fall back to built-in)', () => {
    const d = decideTimeout('vitest run', 350_000, {
      configOverride: { 'vitest-jest': { max_ms: 'unlimited' } },
    });
    assert.equal(d.action, 'warn'); // built-in 300_000 ceiling still applies
  });

  it('default config carries empty bash_timeout object', () => {
    const cfg = loadConfig(tmp);
    assert.deepEqual(cfg.bash_timeout, {});
  });
});
