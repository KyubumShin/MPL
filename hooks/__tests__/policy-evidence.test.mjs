/**
 * Tests for hooks/lib/policy/evidence.mjs (Move #8 Phase A).
 *
 * Validates that the structural per-token checks are STRONGER than the
 * legacy substring+'pass' Evidence Latch — a phase that only writes
 * "test_agent: pass" to verification.md without dispatching test_agent
 * MUST block; an api_contract token without .mpl/contracts/<file> MUST
 * block; unknown tokens MUST block with `unknown_evidence_token`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  verifyToken,
  verifyPhase,
  getSupportedTokens,
  SUPPORTED_TOKENS,
} from '../lib/policy/evidence.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-policy-evidence-'));
  mkdirSync(join(dir, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
  return dir;
}

test('getSupportedTokens returns the registry list', () => {
  const list = getSupportedTokens();
  assert.ok(Array.isArray(list));
  assert.ok(list.includes('command'));
  assert.ok(list.includes('test_agent'));
  assert.ok(list.includes('api_contract'));
  assert.ok(list.includes('error_spec'));
  assert.equal(list.length, SUPPORTED_TOKENS.length);
});

test('unknown evidence token is blocked with supported-list hint', () => {
  const dir = fresh();
  try {
    const r = verifyToken('made_up_token', {
      cwd: dir,
      state: {},
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, false);
    assert.equal(r.supported, false);
    assert.ok(r.issues.some((i) => i.includes('unknown_evidence_token')));
    assert.ok(r.issues.some((i) => i.startsWith('supported:')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('command token: structural hard1 exit_code=0 passes', () => {
  const dir = fresh();
  try {
    const r = verifyToken('command', {
      cwd: dir,
      state: { gate_results: { hard1: { exit_code: 0 } } },
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, true, JSON.stringify(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('command token: substring "command exit_code 0" in verification.md is REJECTED without fallback', () => {
  const dir = fresh();
  try {
    const r = verifyToken('command', {
      cwd: dir,
      state: {},
      phaseId: 'phase-1',
      verificationText: 'command: exit_code = 0\n', // substring-only
      config: { evidence: { rules: [{ token: 'command', fallback_allowed: false }] } },
    });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('command:missing_exit_code_0')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('command token: text fallback works when explicitly opted in via config', () => {
  const dir = fresh();
  try {
    const r = verifyToken('command', {
      cwd: dir,
      state: {},
      phaseId: 'phase-1',
      verificationText: 'command exit_code: 0\n',
      config: {
        evidence: {
          allow_legacy_text_fallback: true,
          rules: [{ token: 'command', fallback_allowed: true }],
        },
      },
    });
    assert.equal(r.valid, true, JSON.stringify(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test_agent token: substring "test_agent: pass" in verification.md is REJECTED', () => {
  const dir = fresh();
  try {
    // Phase MUST block when no structured evidence even with the
    // legacy verification text claiming pass.
    const r = verifyToken('test_agent', {
      cwd: dir,
      state: { test_agent_dispatched: {} },
      phaseId: 'phase-1',
      verificationText: 'test_agent: pass\n',
    });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('test_agent:missing_pass_evidence')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test_agent token: structured PASS evidence passes', () => {
  const dir = fresh();
  try {
    const r = verifyToken('test_agent', {
      cwd: dir,
      state: {
        test_agent_dispatched: {
          'phase-1': {
            valid_json: true,
            verdict: 'PASS',
            invalid_reason: null,
            tests_total: 5,
            tests_failed: 0,
            tests_skipped: 0,
            test_files_created_count: 2,
            command_exit_codes_count: 3,
            command_exit_codes_nonzero_count: 0,
            bugs_found_count: 0,
          },
        },
      },
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, true, JSON.stringify(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('api_contract token: contract_files declared but file missing on disk BLOCKS', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: API Boundary
    contract_files:
      - .mpl/contracts/api.yaml
`,
    );
    const r = verifyToken('api_contract', {
      cwd: dir,
      state: {},
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('api_contract:file_missing')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('api_contract token: missing contract_files field BLOCKS', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: API Boundary
`,
    );
    const r = verifyToken('api_contract', {
      cwd: dir,
      state: {},
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('contract_files_missing')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('api_contract token: contract file present passes', () => {
  const dir = fresh();
  try {
    mkdirSync(join(dir, '.mpl', 'contracts'), { recursive: true });
    writeFileSync(
      join(dir, '.mpl', 'contracts', 'api.json'),
      JSON.stringify({ boundary_id: 'login' }),
    );
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: API
    contract_files:
      - .mpl/contracts/api.json
`,
    );
    const r = verifyToken('api_contract', {
      cwd: dir,
      state: {},
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, true, JSON.stringify(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('error_spec token: rejects missing array', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: Errors
`,
    );
    const r = verifyToken('error_spec', { cwd: dir, state: {}, phaseId: 'phase-1' });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('error_spec:missing_or_empty')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('error_spec token: valid entries pass', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: Errors
    error_spec:
      - code: AUTH_FAILED
        message: bad token
      - code: RATE_LIMIT
        message: too many requests
`,
    );
    const r = verifyToken('error_spec', { cwd: dir, state: {}, phaseId: 'phase-1' });
    assert.equal(r.valid, true, JSON.stringify(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('error_spec token: invalid code shape rejected', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: Errors
    error_spec:
      - code: lowercase_no_good
        message: bad shape
`,
    );
    const r = verifyToken('error_spec', { cwd: dir, state: {}, phaseId: 'phase-1' });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('error_spec:invalid_code')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file_exists token: enumerates impact.create paths', () => {
  const dir = fresh();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'foo.ts'), '// stub\n');
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: Files
    impact:
      create:
        - path: src/foo.ts
`,
    );
    const r = verifyToken('file_exists', { cwd: dir, state: {}, phaseId: 'phase-1' });
    assert.equal(r.valid, true, JSON.stringify(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file_exists token: missing file is reported', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: Files
    impact:
      create:
        - path: src/missing.ts
`,
    );
    const r = verifyToken('file_exists', { cwd: dir, state: {}, phaseId: 'phase-1' });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('file_exists:missing:src/missing.ts')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tests_pass token: junit failures cause block', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'phases', 'phase-1', 'junit.xml'),
      '<?xml version="1.0"?><testsuite tests="3" failures="1" errors="0"></testsuite>',
    );
    const r = verifyToken('tests_pass', { cwd: dir, state: {}, phaseId: 'phase-1' });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('junit_failed')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tests_pass token: clean junit passes', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'phases', 'phase-1', 'junit.xml'),
      '<?xml version="1.0"?><testsuite tests="5" failures="0" errors="0"></testsuite>',
    );
    const r = verifyToken('tests_pass', { cwd: dir, state: {}, phaseId: 'phase-1' });
    assert.equal(r.valid, true, JSON.stringify(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('security token: structured findings clean passes', () => {
  const dir = fresh();
  try {
    const r = verifyToken('security', {
      cwd: dir,
      state: { security_results: { snyk: { findings: [{ severity: 'low' }] } } },
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, true, JSON.stringify(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('security token: high-severity finding BLOCKS', () => {
  const dir = fresh();
  try {
    const r = verifyToken('security', {
      cwd: dir,
      state: { security_results: { snyk: { findings: [{ severity: 'high' }] } } },
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual token: requires attested_by + attested_at', () => {
  const dir = fresh();
  try {
    const r1 = verifyToken('manual', {
      cwd: dir, state: {}, phaseId: 'phase-1',
    });
    assert.equal(r1.valid, false);

    const r2 = verifyToken('manual', {
      cwd: dir,
      state: {
        gate_results: {
          manual_attestation: { 'phase-1': { attested_by: 'kbshin', attested_at: '2026-05-31T00:00:00Z' } },
        },
      },
      phaseId: 'phase-1',
    });
    assert.equal(r2.valid, true, JSON.stringify(r2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export_manifest token: requires release manifest entry', () => {
  const dir = fresh();
  try {
    const cutId = 'cut-1';
    mkdirSync(join(dir, '.mpl', 'mpl', 'releases', cutId), { recursive: true });
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'releases', cutId, 'release-manifest.json'),
      JSON.stringify({ phases: ['phase-1', 'phase-2'] }),
    );
    const r = verifyToken('export_manifest', {
      cwd: dir,
      state: { release: { current_cut_id: cutId } },
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, true, JSON.stringify(r));

    const r2 = verifyToken('export_manifest', {
      cwd: dir,
      state: { release: { current_cut_id: cutId } },
      phaseId: 'phase-99',
    });
    assert.equal(r2.valid, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('type_policy token: requires field + hard1 typecheck pass', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: Types
    type_policy: tsc-strict
`,
    );
    const r = verifyToken('type_policy', {
      cwd: dir,
      state: { gate_results: { hard1: { exit_code: 0 } } },
      phaseId: 'phase-1',
    });
    assert.equal(r.valid, true, JSON.stringify(r));

    // Missing field — block
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: Types
`,
    );
    const r2 = verifyToken('type_policy', {
      cwd: dir,
      state: { gate_results: { hard1: { exit_code: 0 } } },
      phaseId: 'phase-1',
    });
    assert.equal(r2.valid, false);
    assert.ok(r2.issues.some((i) => i.includes('type_policy:missing_field')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyPhase composes per-token results', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: P
    evidence_required: [command, test_agent]
    goal_trace:
      acceptance_criteria: [AC-1]
`,
    );
    const r = verifyPhase('phase-1', {
      cwd: dir,
      state: { gate_results: { hard1: { exit_code: 0 } } }, // command passes; test_agent fails
    });
    assert.equal(r.valid, false);
    assert.ok(r.tokens.find((t) => t.token === 'command' && t.valid === true));
    assert.ok(r.tokens.find((t) => t.token === 'test_agent' && t.valid === false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyPhase: missing phase block blocks', () => {
  const dir = fresh();
  try {
    const r = verifyPhase('phase-404', { cwd: dir, state: {} });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('phase-404:phase:missing')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyPhase: phase with no evidence_required blocks', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `
phases:
  - id: phase-1
    name: Empty
`,
    );
    const r = verifyPhase('phase-1', { cwd: dir, state: {} });
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.includes('evidence_required:missing')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
