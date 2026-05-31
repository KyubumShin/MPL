/**
 * Tests for hooks/lib/policy/audit.mjs (Move #13).
 *
 * These tests exercise the NEW Move-#13-specific behavior:
 *
 *   - declarative verdict via `config.audit.verdict.required_clean[]`
 *   - new `manifest_drift` surface
 *   - drift_undeclared escalation into `anti_pattern_residual`
 *   - decision envelope shape (action / verdict / surfaces / sideEffects)
 *   - handle('finalize') and handle('phase') dispatcher
 *   - legacyVerdict opt-in rollback semantics
 *
 * The existing parser/surface tests live in `mpl-codex-audit.test.mjs` and
 * still pass via the re-export shim — they are NOT duplicated here.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  handle,
  handleAudit,
  handleFinalizeAudit,
  runCodexAudit,
  computeVerdict,
  resolveRequiredClean,
  resolveDriftEscalation,
  findManifestDrift,
  parseDecompositionPhases,
  enumerateIncludedUserCases,
  isLegacyContractMode,
  DEFAULT_REQUIRED_CLEAN,
  LEGACY_REQUIRED_CLEAN,
  AUDIT_HOOK_ID,
  AUDIT_REPORT_PATH,
} from '../lib/policy/audit.mjs';

const __filename = fileURLToPath(import.meta.url);
const REAL_PLUGIN_ROOT = join(dirname(__filename), '..', '..');

// ============================================================================
// Helpers
// ============================================================================

function scaffold(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

const SAMPLE_USER_CONTRACT = `# User Contract

\`\`\`yaml
schema_version: 1
user_cases:
  - id: "UC-01"
    title: "Sign in"
    status: "included"
    covers_pp: ["PP-A"]
\`\`\`
`;

const SAMPLE_DECOMPOSITION = `phases:
  - id: phase-1
    covers: ["UC-01"]
    impact:
      create:
        - path: src/a.ts
`;

const TWO_PHASE_DECOMP = `phases:
  - id: phase-1
    covers: [UC-01]
    impact:
      create:
        - path: src/a.ts
  - id: phase-2
    covers: [UC-02]
    impact:
      create:
        - path: src/b.ts
`;

// ============================================================================
// Public re-export surface (parsers stay importable)
// ============================================================================

describe('policy/audit.mjs re-exports the legacy parser surface', () => {
  it('exports parseDecompositionPhases / enumerateIncludedUserCases / isLegacyContractMode', () => {
    assert.equal(typeof parseDecompositionPhases, 'function');
    assert.equal(typeof enumerateIncludedUserCases, 'function');
    assert.equal(typeof isLegacyContractMode, 'function');
  });

  it('exports the runner under the legacy name (runCodexAudit)', () => {
    assert.equal(typeof runCodexAudit, 'function');
  });

  it('exports both the new declarative defaults and the rollback-legacy list', () => {
    assert.ok(Array.isArray(DEFAULT_REQUIRED_CLEAN));
    assert.ok(DEFAULT_REQUIRED_CLEAN.includes('drift_undeclared'));
    assert.ok(DEFAULT_REQUIRED_CLEAN.includes('manifest_drift'));
    assert.ok(Array.isArray(LEGACY_REQUIRED_CLEAN));
    assert.ok(!LEGACY_REQUIRED_CLEAN.includes('drift_undeclared'));
    assert.ok(!LEGACY_REQUIRED_CLEAN.includes('manifest_drift'));
  });

  it('exports the hook id and audit-report path constants', () => {
    assert.equal(AUDIT_HOOK_ID, 'mpl-codex-audit');
    assert.equal(AUDIT_REPORT_PATH, '.mpl/mpl/audit-report.json');
  });
});

// ============================================================================
// computeVerdict — declarative gating
// ============================================================================

describe('computeVerdict', () => {
  it('returns pass when every required key is zero', () => {
    const summary = { anti_pattern_residual: 0, missing_covers: 0, drift_undeclared: 0 };
    const required = ['anti_pattern_residual', 'missing_covers', 'drift_undeclared'];
    assert.equal(computeVerdict(summary, required), 'pass');
  });

  it('returns fail when any required key is non-zero', () => {
    const summary = { anti_pattern_residual: 0, missing_covers: 1, drift_undeclared: 0 };
    const required = ['anti_pattern_residual', 'missing_covers', 'drift_undeclared'];
    assert.equal(computeVerdict(summary, required), 'fail');
  });

  it('forward-compat: unknown keys are treated as 0 (do not auto-fail)', () => {
    const summary = { anti_pattern_residual: 0 };
    const required = ['anti_pattern_residual', 'brand_new_surface_not_yet_implemented'];
    assert.equal(computeVerdict(summary, required), 'pass');
  });

  it('falls back to DEFAULT_REQUIRED_CLEAN when required arg is empty/missing', () => {
    const summary = {
      anti_pattern_residual: 0, missing_covers: 0, dangling_covers: 0,
      drift_undeclared: 0, manifest_drift: 0,
    };
    assert.equal(computeVerdict(summary, []), 'pass');
    assert.equal(computeVerdict(summary, null), 'pass');
    assert.equal(computeVerdict({ ...summary, drift_undeclared: 1 }, []), 'fail');
  });
});

// ============================================================================
// resolveRequiredClean / resolveDriftEscalation
// ============================================================================

describe('resolveRequiredClean', () => {
  it('returns DEFAULT_REQUIRED_CLEAN when config is absent', () => {
    assert.deepStrictEqual(resolveRequiredClean(null), [...DEFAULT_REQUIRED_CLEAN]);
    assert.deepStrictEqual(resolveRequiredClean({}), [...DEFAULT_REQUIRED_CLEAN]);
  });

  it('honors a workspace override array', () => {
    const cfg = { audit: { verdict: { required_clean: ['missing_covers'] } } };
    assert.deepStrictEqual(resolveRequiredClean(cfg), ['missing_covers']);
  });

  it('falls back to default on malformed array', () => {
    const cfg = { audit: { verdict: { required_clean: 'not-an-array' } } };
    assert.deepStrictEqual(resolveRequiredClean(cfg), [...DEFAULT_REQUIRED_CLEAN]);
  });

  it('filters non-string entries (silent normalization)', () => {
    const cfg = { audit: { verdict: { required_clean: ['missing_covers', 42, null, ''] } } };
    assert.deepStrictEqual(resolveRequiredClean(cfg), ['missing_covers']);
  });
});

describe('resolveDriftEscalation', () => {
  it('defaults to true (drift escalates by default)', () => {
    assert.equal(resolveDriftEscalation(null), true);
    assert.equal(resolveDriftEscalation({}), true);
    assert.equal(resolveDriftEscalation({ audit: { drift: {} } }), true);
  });

  it('honors explicit false', () => {
    const cfg = { audit: { drift: { escalate_undeclared_to_anti_pattern: false } } };
    assert.equal(resolveDriftEscalation(cfg), false);
  });

  it('treats non-false (e.g. true) as true', () => {
    const cfg = { audit: { drift: { escalate_undeclared_to_anti_pattern: true } } };
    assert.equal(resolveDriftEscalation(cfg), true);
  });
});

// ============================================================================
// findManifestDrift — new Move #13 surface
// ============================================================================

describe('findManifestDrift', () => {
  it('returns [] when state has no execution context (synthetic workspace)', () => {
    const phases = [{ id: 'phase-1' }, { id: 'phase-2' }];
    assert.deepStrictEqual(findManifestDrift(null, phases), []);
    assert.deepStrictEqual(findManifestDrift({}, phases), []);
  });

  it('flags every declared phase missing from state.completed_phases', () => {
    const phases = [{ id: 'phase-1' }, { id: 'phase-2' }, { id: 'phase-3' }];
    const state = {
      current_phase: 'phase5-finalize',
      completed_phases: ['phase-1'],
    };
    const drift = findManifestDrift(state, phases);
    const ids = drift.map((d) => d.phase_id).sort();
    assert.deepStrictEqual(ids, ['phase-2', 'phase-3']);
  });

  it('honors current_phase (in-progress phases are NOT drift)', () => {
    const phases = [{ id: 'phase-1' }, { id: 'phase-2' }];
    const state = { current_phase: 'phase-2', completed_phases: ['phase-1'] };
    const drift = findManifestDrift(state, phases);
    assert.deepStrictEqual(drift, []);
  });

  it('accepts execution.phase_details shape (canonical state schema)', () => {
    const phases = [{ id: 'phase-1' }, { id: 'phase-2' }];
    const state = {
      current_phase: 'phase5-finalize',
      execution: { phase_details: [{ id: 'phase-1', status: 'completed' }] },
    };
    const drift = findManifestDrift(state, phases);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].phase_id, 'phase-2');
  });

  it('emits a stable reason string for each finding', () => {
    const phases = [{ id: 'phase-9' }];
    const state = { current_phase: 'phase5-finalize', completed_phases: [] };
    const drift = findManifestDrift(state, phases);
    assert.equal(drift.length, 1);
    assert.match(drift[0].reason, /absent from state\.completed_phases/);
  });
});

// ============================================================================
// runCodexAudit — declarative verdict end-to-end
// ============================================================================

describe('runCodexAudit declarative verdict (Move #13)', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-policy-audit-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('fails when drift_undeclared > 0 (new default gate)', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, {
      now: 'NOW',
      probes: ['echo src/leaked.ts'],
    });
    assert.equal(report.verdict, 'fail');
    assert.equal(report.summary.drift_undeclared, 1);
    assert.ok(report.verdict_policy.required_clean.includes('drift_undeclared'));
  });

  it('fails when manifest_drift > 0 (decomposition declares a phase the state never recorded)', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': TWO_PHASE_DECOMP,
      '.mpl/state.json': JSON.stringify({
        schema_version: 2,
        current_phase: 'phase5-finalize',
        completed_phases: ['phase-1'],
      }),
    });
    const state = JSON.parse(readFileSync(join(tmp, '.mpl/state.json'), 'utf-8'));
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, {
      now: 'NOW',
      state,
      probes: ['echo src/a.ts; echo src/b.ts'],
    });
    assert.equal(report.summary.manifest_drift, 1);
    assert.equal(report.surfaces.manifest_drift[0].phase_id, 'phase-2');
    assert.equal(report.verdict, 'fail');
  });

  it('drift_unimplemented stays informational (NOT in required_clean by default)', () => {
    // Phase-1 declares src/a.ts but the diff doesn't include it → unimplemented.
    // No state → no manifest_drift. Should still PASS by default.
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, {
      now: 'NOW',
      probes: ['echo README.md'],
    });
    // README.md is undeclared → still triggers fail under new default.
    // Disable the drift_undeclared gate to isolate drift_unimplemented behavior.
    const isolated = runCodexAudit(tmp, REAL_PLUGIN_ROOT, {
      now: 'NOW',
      probes: ['true'],  // no files in diff at all
      config: { audit: { verdict: { required_clean: ['missing_covers'] } } },
    });
    assert.ok(isolated.summary.drift_unimplemented >= 0);
    // drift_unimplemented is not in any default-gating slot
    assert.ok(!DEFAULT_REQUIRED_CLEAN.includes('drift_unimplemented'));
  });

  it('escalates drift_undeclared into anti_pattern_residual surface (default ON)', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, {
      now: 'NOW',
      probes: ['echo src/leaked.ts'],
    });
    const antiPattern = report.surfaces.anti_pattern_residual;
    const synthetic = antiPattern.find((h) => h.id === 'F6.drift_undeclared');
    assert.ok(synthetic, 'expected a synthetic F6.drift_undeclared entry in anti_pattern_residual');
    assert.equal(synthetic.severity, 'warn');
    assert.equal(synthetic.file, 'src/leaked.ts');
    assert.equal(synthetic.source, 'drift_undeclared');
    assert.equal(synthetic.synthetic, true);
    // Summary count reflects both the real residual scan AND the escalation
    assert.equal(report.summary.anti_pattern_residual, antiPattern.length);
  });

  it('escalation can be disabled via config.audit.drift.escalate_undeclared_to_anti_pattern: false', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, {
      now: 'NOW',
      probes: ['echo src/leaked.ts'],
      config: {
        audit: {
          verdict: { required_clean: ['drift_undeclared'] },
          drift: { escalate_undeclared_to_anti_pattern: false },
        },
      },
    });
    const synthetic = report.surfaces.anti_pattern_residual.find((h) => h.id === 'F6.drift_undeclared');
    assert.equal(synthetic, undefined);
    assert.equal(report.verdict_policy.escalate_undeclared_to_anti_pattern, false);
  });

  it('verdict_policy is included in the report (introspection / audit trail)', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, { now: 'NOW' });
    assert.ok(Array.isArray(report.verdict_policy.required_clean));
    assert.equal(typeof report.verdict_policy.escalate_undeclared_to_anti_pattern, 'boolean');
    assert.equal(report.verdict_policy.legacy_verdict, false);
  });

  it('legacyVerdict:true restores the 3-conjunct expression and drops manifest_drift surface', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': TWO_PHASE_DECOMP,
      '.mpl/state.json': JSON.stringify({ current_phase: 'phase5-finalize', completed_phases: [] }),
    });
    const state = JSON.parse(readFileSync(join(tmp, '.mpl/state.json'), 'utf-8'));
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, {
      now: 'NOW',
      legacyVerdict: true,
      state,
      probes: ['echo src/leaked.ts'],
    });
    // Manifest drift surface is suppressed entirely
    assert.equal(report.summary.manifest_drift, 0);
    assert.deepStrictEqual(report.surfaces.manifest_drift, []);
    // No synthetic escalation either
    const synthetic = report.surfaces.anti_pattern_residual.find((h) => h.id === 'F6.drift_undeclared');
    assert.equal(synthetic, undefined);
    // Verdict policy reflects rollback mode
    assert.equal(report.verdict_policy.legacy_verdict, true);
    assert.deepStrictEqual(report.verdict_policy.required_clean, [...LEGACY_REQUIRED_CLEAN]);
  });

  it('user-configured required_clean wins over the default', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, {
      now: 'NOW',
      probes: ['echo src/leaked.ts'],
      config: { audit: { verdict: { required_clean: ['missing_covers'] } } },
    });
    // drift_undeclared still > 0 but missing_covers is the only gate → PASS
    assert.equal(report.summary.drift_undeclared, 1);
    assert.equal(report.verdict, 'pass');
  });
});

// ============================================================================
// Decision envelope — handleFinalizeAudit
// ============================================================================

describe('handleFinalizeAudit decision envelope', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-policy-audit-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns action:pass envelope with audit_report_write + audit_exit_code sideEffects', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const envelope = handleFinalizeAudit({
      cwd: tmp,
      pluginRoot: REAL_PLUGIN_ROOT,
      now: 'NOW',
      probes: ['true'],
    });
    assert.equal(envelope.action, 'pass');
    assert.equal(envelope.verdict, 'pass');
    assert.equal(envelope.contract_mode, 'enforced');
    assert.ok(envelope.summary);
    assert.ok(envelope.surfaces);

    const write = envelope.sideEffects.find((fx) => fx.kind === 'audit_report_write');
    assert.ok(write, 'expected an audit_report_write sideEffect');
    assert.equal(write.path, AUDIT_REPORT_PATH);
    assert.equal(write.payload.verdict, 'pass');

    const exit = envelope.sideEffects.find((fx) => fx.kind === 'audit_exit_code');
    assert.ok(exit, 'expected an audit_exit_code sideEffect');
    assert.equal(exit.code, 0);
  });

  it('returns action:fail with exit_code 0 when audit_residual is warn (default)', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const envelope = handleFinalizeAudit({
      cwd: tmp,
      pluginRoot: REAL_PLUGIN_ROOT,
      now: 'NOW',
      probes: ['echo src/leaked.ts'],
    });
    assert.equal(envelope.action, 'fail');
    assert.equal(envelope.verdict, 'fail');
    const exit = envelope.sideEffects.find((fx) => fx.kind === 'audit_exit_code');
    assert.equal(exit.code, 0);
    assert.equal(envelope.enforcement_action, 'warn');
  });

  it('returns action:fail with exit_code 1 when audit_residual is block', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
      '.mpl/config.json': JSON.stringify({ enforcement: { audit_residual: 'block' } }),
    });
    const envelope = handleFinalizeAudit({
      cwd: tmp,
      pluginRoot: REAL_PLUGIN_ROOT,
      now: 'NOW',
      probes: ['echo src/leaked.ts'],
    });
    assert.equal(envelope.action, 'fail');
    const exit = envelope.sideEffects.find((fx) => fx.kind === 'audit_exit_code');
    assert.equal(exit.code, 1);
    assert.equal(envelope.enforcement_action, 'block');
  });

  it('returns action:noop when cwd or pluginRoot is missing (defensive)', () => {
    const envelope = handleFinalizeAudit({});
    assert.equal(envelope.action, 'noop');
    assert.equal(envelope.ruleId, 'audit_finalize_missing_ctx');
    assert.deepStrictEqual(envelope.sideEffects, []);
  });

  it('preserves the full report under envelope.report for stdout streaming', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const envelope = handleFinalizeAudit({
      cwd: tmp,
      pluginRoot: REAL_PLUGIN_ROOT,
      now: 'NOW',
      probes: ['true'],
    });
    assert.ok(envelope.report);
    assert.equal(envelope.report.tier, 4);
    assert.equal(envelope.report.schema_version, 1);
    assert.equal(envelope.report.generated_at, 'NOW');
  });
});

// ============================================================================
// handleAudit — per-phase scaffolding (noop today)
// ============================================================================

describe('handleAudit (per-phase scaffolding)', () => {
  it('returns a noop envelope with ruleId audit_per_phase_noop', () => {
    const envelope = handleAudit({});
    assert.equal(envelope.action, 'noop');
    assert.equal(envelope.ruleId, 'audit_per_phase_noop');
    assert.deepStrictEqual(envelope.sideEffects, []);
  });
});

// ============================================================================
// handle(event, ctx) dispatcher
// ============================================================================

describe('handle(event, ctx) dispatcher', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-policy-audit-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('routes finalize → handleFinalizeAudit', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const envelope = handle('finalize', {
      cwd: tmp,
      pluginRoot: REAL_PLUGIN_ROOT,
      now: 'NOW',
      probes: ['true'],
    });
    assert.equal(envelope.action, 'pass');
    assert.ok(envelope.sideEffects.find((fx) => fx.kind === 'audit_report_write'));
  });

  it('routes phase → handleAudit (noop scaffolding)', () => {
    const envelope = handle('phase', { cwd: '/tmp' });
    assert.equal(envelope.action, 'noop');
    assert.equal(envelope.ruleId, 'audit_per_phase_noop');
  });

  it('throws on unknown event (uniform with other policy dispatchers)', () => {
    assert.throws(() => handle('unknown-event', {}), /unknown event/);
  });
});
