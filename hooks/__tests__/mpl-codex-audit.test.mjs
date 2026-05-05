/**
 * F6 (#117) — codex auditor unit tests.
 *
 * Covers all three audit surfaces (anti-pattern residual, missing covers,
 * drift) plus the runner envelope verdict logic plus the CLI smoke path.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { execSync } from 'node:child_process';

import {
  enumerateIncludedUserCases,
  isLegacyContractMode,
  parseDecompositionPhases,
  findMissingCovers,
  findScopeDrift,
  auditAntiPatternResidual,
  runCodexAudit,
} from '../lib/mpl-codex-audit.mjs';

const __filename = fileURLToPath(import.meta.url);
const CLI_PATH = join(dirname(__filename), '..', 'mpl-codex-audit.mjs');
const REAL_PLUGIN_ROOT = join(dirname(__filename), '..', '..');

/* ────────────────────────── Helpers ──────────────────────────────────────── */

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
created_at: "2026-05-05T00:00:00Z"
iterations: 1

user_cases:
  - id: "UC-01"
    title: "Sign in with Google"
    user_delta: ""
    priority: "P0"
    status: "included"
    covers_pp: ["PP-A"]
    acceptance_hint: "OAuth flow returns to /home"
  - id: "UC-02"
    title: "Sign out"
    user_delta: ""
    priority: "P0"
    status: "included"
    covers_pp: ["PP-A"]

deferred_cases:
  - id: "UC-09"
    title: "Profile picture upload"
    reason: "post-MVP"
    revisit_at: "post-v0.17"
    source_round: 2

cut_cases: []
scenarios: []
\`\`\`
`;

const SAMPLE_DECOMPOSITION = `phases:
  - id: phase-1
    scope: "Auth scaffolding"
    covers: ["UC-01"]
    impact:
      create:
        - path: "src/auth/google.ts"
        - path: "src/auth/index.ts"
      modify:
        - path: "src/main.ts"
      affected_tests:
        - path: "src/auth/__tests__/google.test.ts"
    interface_contract:
      contract_files: []
    success_criteria:
      - command: "npm test src/auth"

  - id: phase-2
    scope: "Sign out"
    covers:
      - "UC-02"
    impact:
      create:
        - path: "src/auth/signout.ts"
      modify:
        - path: "src/auth/index.ts"
    interface_contract:
      contract_files: []
    success_criteria:
      - command: "npm test"
`;

/* ────────────────────────── enumerateIncludedUserCases ───────────────────── */

describe('enumerateIncludedUserCases', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-f6-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns empty when user-contract.md is missing', () => {
    assert.deepStrictEqual(enumerateIncludedUserCases(tmp), []);
  });

  it('extracts only included UCs (filters deferred/cut)', () => {
    scaffold(tmp, { '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT });
    const ucs = enumerateIncludedUserCases(tmp);
    assert.deepStrictEqual(ucs.map(u => u.id), ['UC-01', 'UC-02']);
    assert.equal(ucs[0].title, 'Sign in with Google');
  });

  it('treats UC without explicit status as included (schema: section is included-only)', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': `# UC

\`\`\`yaml
user_cases:
  - id: "UC-77"
    title: "Implicit included"
    priority: "P0"
\`\`\`
`,
    });
    const ucs = enumerateIncludedUserCases(tmp);
    assert.equal(ucs.length, 1);
    assert.equal(ucs[0].id, 'UC-77');
  });

  it('returns empty when user_cases section is absent', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': `# User Contract

No user_cases here.
`,
    });
    assert.deepStrictEqual(enumerateIncludedUserCases(tmp), []);
  });

  it('does not bleed into deferred_cases', () => {
    scaffold(tmp, { '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT });
    const ucs = enumerateIncludedUserCases(tmp);
    const ids = ucs.map(u => u.id);
    assert.ok(!ids.includes('UC-09'), 'UC-09 is deferred and must not appear as included');
  });
});

/* ────────────────────────── parseDecompositionPhases ─────────────────────── */

describe('parseDecompositionPhases', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-f6-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns empty when decomposition.yaml is missing', () => {
    assert.deepStrictEqual(parseDecompositionPhases(tmp), []);
  });

  it('parses inline covers array', () => {
    scaffold(tmp, { '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION });
    const phases = parseDecompositionPhases(tmp);
    const phase1 = phases.find(p => p.id === 'phase-1');
    assert.deepStrictEqual(phase1.covers, ['UC-01']);
  });

  it('parses YAML-list-form covers', () => {
    scaffold(tmp, { '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION });
    const phases = parseDecompositionPhases(tmp);
    const phase2 = phases.find(p => p.id === 'phase-2');
    assert.deepStrictEqual(phase2.covers, ['UC-02']);
  });

  it('extracts create + modify paths into impact_files (excludes affected_tests)', () => {
    scaffold(tmp, { '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION });
    const phases = parseDecompositionPhases(tmp);
    const phase1 = phases.find(p => p.id === 'phase-1');
    assert.deepStrictEqual(
      phase1.impact_files.sort(),
      ['src/auth/google.ts', 'src/auth/index.ts', 'src/main.ts'].sort(),
    );
    // affected_tests must NOT appear in impact_files
    assert.ok(!phase1.impact_files.includes('src/auth/__tests__/google.test.ts'));
  });

  it('handles `internal` covers escape', () => {
    scaffold(tmp, {
      '.mpl/mpl/decomposition.yaml': `phases:
  - id: phase-3
    scope: "Plumbing only"
    covers: ["internal"]
    impact:
      create:
        - path: "src/util/index.ts"
`,
    });
    const phases = parseDecompositionPhases(tmp);
    assert.deepStrictEqual(phases[0].covers, ['internal']);
  });
});

/* ────────────────────────── findMissingCovers ────────────────────────────── */

describe('findMissingCovers', () => {
  it('reports uncovered UCs', () => {
    const ucs = [
      { id: 'UC-01', title: 'A' },
      { id: 'UC-02', title: 'B' },
      { id: 'UC-03', title: 'C' },
    ];
    const phases = [
      { id: 'p1', covers: ['UC-01'], impact_files: [] },
      { id: 'p2', covers: ['UC-02'], impact_files: [] },
    ];
    const { uncovered, dangling } = findMissingCovers(ucs, phases);
    assert.equal(uncovered.length, 1);
    assert.equal(uncovered[0].uc_id, 'UC-03');
    assert.deepStrictEqual(dangling, []);
  });

  it('reports dangling claims (phase covers UC not in included)', () => {
    const ucs = [{ id: 'UC-01', title: 'A' }];
    const phases = [
      { id: 'p1', covers: ['UC-01', 'UC-99'], impact_files: [] },
    ];
    const { uncovered, dangling } = findMissingCovers(ucs, phases);
    assert.deepStrictEqual(uncovered, []);
    assert.equal(dangling.length, 1);
    assert.equal(dangling[0].uc_id, 'UC-99');
    assert.equal(dangling[0].phase_id, 'p1');
  });

  it('honours `internal` escape (no dangling, no contribution to coverage)', () => {
    const ucs = [{ id: 'UC-01', title: 'A' }];
    const phases = [
      { id: 'p1', covers: ['UC-01'], impact_files: [] },
      { id: 'p2', covers: ['internal'], impact_files: [] },
    ];
    const { uncovered, dangling } = findMissingCovers(ucs, phases);
    assert.deepStrictEqual(uncovered, []);
    assert.deepStrictEqual(dangling, []);
  });

  it('clean run with full coverage returns empty surfaces', () => {
    const ucs = [{ id: 'UC-01', title: 'A' }, { id: 'UC-02', title: 'B' }];
    const phases = [
      { id: 'p1', covers: ['UC-01'], impact_files: [] },
      { id: 'p2', covers: ['UC-02'], impact_files: [] },
    ];
    const { uncovered, dangling } = findMissingCovers(ucs, phases);
    assert.deepStrictEqual(uncovered, []);
    assert.deepStrictEqual(dangling, []);
  });

  it('empty user-contract → empty surfaces (graceful skip mode)', () => {
    const phases = [{ id: 'p1', covers: ['internal'], impact_files: [] }];
    const { uncovered, dangling } = findMissingCovers([], phases);
    assert.deepStrictEqual(uncovered, []);
    assert.deepStrictEqual(dangling, []);
  });
});

/* ────────────────────────── findScopeDrift ───────────────────────────────── */

describe('findScopeDrift', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-f6-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('reports git_unavailable: true when not a repo', () => {
    const drift = findScopeDrift(tmp, []);
    assert.equal(drift.git_unavailable, true);
    assert.deepStrictEqual(drift.undeclared, []);
    assert.deepStrictEqual(drift.unimplemented, []);
  });

  it('classifies undeclared / unimplemented from a fixed probe', () => {
    const phases = [
      { id: 'p1', covers: [], impact_files: ['src/a.ts', 'src/b.ts'] },
    ];
    // Inject probes that return a fixed file list (avoids needing a real repo).
    const drift = findScopeDrift(tmp, phases, {
      probes: ['echo src/a.ts; echo src/c.ts'],
    });
    assert.deepStrictEqual(drift.undeclared, ['src/c.ts']);
    assert.deepStrictEqual(drift.unimplemented, ['src/b.ts']);
  });

  it('filters __tests__ and *.test.* from undeclared', () => {
    const phases = [{ id: 'p1', covers: [], impact_files: ['src/a.ts'] }];
    const drift = findScopeDrift(tmp, phases, {
      probes: ['printf "src/a.ts\\nsrc/__tests__/a.test.ts\\nsrc/b.test.ts\\nsrc/d.ts\\n"'],
    });
    assert.deepStrictEqual(drift.undeclared, ['src/d.ts']);
  });
});

/* ────────────────────────── auditAntiPatternResidual ─────────────────────── */

describe('auditAntiPatternResidual', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-f6-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns empty when registry is missing', () => {
    const phases = [{ id: 'p1', covers: [], impact_files: ['src/a.mjs'] }];
    scaffold(tmp, { 'src/a.mjs': 'const x = 1;' });
    // Use tmp as both cwd and pluginRoot — no anti-patterns.md will be there
    const hits = auditAntiPatternResidual(tmp, tmp, phases);
    assert.deepStrictEqual(hits, []);
  });

  it('skips files that do not exist on disk (will surface as drift)', () => {
    const phases = [{ id: 'p1', covers: [], impact_files: ['src/never-existed.mjs'] }];
    const hits = auditAntiPatternResidual(tmp, REAL_PLUGIN_ROOT, phases);
    assert.deepStrictEqual(hits, []);
  });

  it('finds anti-pattern hits in declared impact files', () => {
    // Use a synthetic registry to keep the test independent of registry drift.
    const synthRegistry = `# Anti-patterns

## Scope (file extensions)

\`\`\`scope
.mjs .ts
\`\`\`

\`\`\`scope-excluded
.md
\`\`\`

## Patterns

### F6.test · Synthetic catch

- **id**: \`F6.test\`
- **category**: \`fallback-poison\`
- **severity**: \`warn\`
- **escalation**: \`tier_3_only\`
- **rationale**: synthetic test fixture for F6
- **ground-truth count**: 1

\`\`\`regex
\\?\\?\\s*['"]\\s*['"]
\`\`\`

\`\`\`permitted-when
None.
\`\`\`
`;
    scaffold(tmp, {
      'commands/references/anti-patterns.md': synthRegistry,
      'src/leaky.mjs': 'export const v = process.env.X ?? "";',
    });
    const phases = [{ id: 'phase-9', covers: [], impact_files: ['src/leaky.mjs'] }];
    const hits = auditAntiPatternResidual(tmp, tmp, phases);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'F6.test');
    assert.equal(hits[0].phase_id, 'phase-9');
    assert.equal(hits[0].file, 'src/leaky.mjs');
  });

  it('respects registry scope (skips files outside extension allowlist)', () => {
    const synthRegistry = `# Anti-patterns

## Scope (file extensions)

\`\`\`scope
.ts
\`\`\`

\`\`\`scope-excluded
\`\`\`

## Patterns

### F6.test · Synthetic catch

- **id**: \`F6.test\`
- **category**: \`fallback-poison\`
- **severity**: \`warn\`
- **escalation**: \`tier_3_only\`
- **rationale**: test
- **ground-truth count**: 1

\`\`\`regex
forbidden
\`\`\`

\`\`\`permitted-when
None.
\`\`\`
`;
    scaffold(tmp, {
      'commands/references/anti-patterns.md': synthRegistry,
      'src/in.ts': 'forbidden',
      'src/out.py': 'forbidden',
    });
    const phases = [{
      id: 'p1', covers: [],
      impact_files: ['src/in.ts', 'src/out.py'],
    }];
    const hits = auditAntiPatternResidual(tmp, tmp, phases);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'src/in.ts');
  });
});

/* ────────────────────────── runCodexAudit (envelope) ─────────────────────── */

describe('runCodexAudit envelope', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-f6-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns verdict=pass when no surfaces fire', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, { now: 'NOW' });
    assert.equal(report.verdict, 'pass');
    assert.equal(report.summary.missing_covers, 0);
    assert.equal(report.summary.dangling_covers, 0);
    assert.equal(report.summary.anti_pattern_residual, 0);
    assert.equal(report.tier, 4);
    assert.equal(report.schema_version, 1);
    assert.equal(report.generated_at, 'NOW');
    assert.equal(report.inputs.included_ucs, 2);
    assert.equal(report.inputs.decomposition_phases, 2);
  });

  it('returns verdict=fail when missing covers > 0', () => {
    // UC-03 included but no phase covers it.
    const wider = SAMPLE_USER_CONTRACT.replace(
      'deferred_cases:',
      `  - id: "UC-03"
    title: "Uncovered case"
    priority: "P1"
    status: "included"
    covers_pp: ["PP-A"]

deferred_cases:`,
    );
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': wider,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, { now: 'NOW' });
    assert.equal(report.verdict, 'fail');
    assert.equal(report.summary.missing_covers, 1);
    assert.equal(report.surfaces.missing_covers[0].uc_id, 'UC-03');
  });

  it('drift surface alone does NOT fail the verdict (informational only)', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, {
      now: 'NOW',
      probes: ['echo src/undeclared.ts'],
    });
    assert.equal(report.verdict, 'pass');
    assert.equal(report.summary.drift_undeclared, 1);
    assert.equal(report.surfaces.drift.undeclared[0], 'src/undeclared.ts');
  });

  it('tolerates entirely empty workspace (graceful skip)', () => {
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, { now: 'NOW' });
    assert.equal(report.verdict, 'pass');
    assert.equal(report.inputs.decomposition_phases, 0);
    assert.equal(report.inputs.included_ucs, 0);
  });
});

/* ────────────────────────── CLI smoke ────────────────────────────────────── */

describe('mpl-codex-audit CLI', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-f6-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('writes audit-report.json and exits 0 on pass', () => {
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const stdout = execFileSync('node', [CLI_PATH, tmp], { encoding: 'utf-8' });
    const reportFromStdout = JSON.parse(stdout);
    assert.equal(reportFromStdout.verdict, 'pass');

    const onDisk = JSON.parse(readFileSync(join(tmp, '.mpl/mpl/audit-report.json'), 'utf-8'));
    assert.equal(onDisk.verdict, 'pass');
    assert.equal(onDisk.tier, 4);
  });

  it('exits 2 on missing workspaceRoot', () => {
    const missing = join(tmp, 'does-not-exist');
    let exitCode = 0;
    try {
      execFileSync('node', [CLI_PATH, missing], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (err) {
      exitCode = err.status;
    }
    assert.equal(exitCode, 2);
  });

  it('exits 0 on fail when audit_residual is not configured (default warn)', () => {
    // UC-03 included but uncovered → verdict=fail
    const wider = SAMPLE_USER_CONTRACT.replace(
      'deferred_cases:',
      `  - id: "UC-03"
    title: "Uncovered"
    priority: "P1"
    status: "included"
    covers_pp: ["PP-A"]

deferred_cases:`,
    );
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': wider,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
    });
    const stdout = execFileSync('node', [CLI_PATH, tmp], { encoding: 'utf-8' });
    const report = JSON.parse(stdout);
    assert.equal(report.verdict, 'fail');
    // exit 0 because no enforcement.audit_residual = 'block' set
  });

  it('exits 1 on fail when enforcement.audit_residual === block', () => {
    const wider = SAMPLE_USER_CONTRACT.replace(
      'deferred_cases:',
      `  - id: "UC-03"
    title: "Uncovered"
    priority: "P1"
    status: "included"
    covers_pp: ["PP-A"]

deferred_cases:`,
    );
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': wider,
      '.mpl/mpl/decomposition.yaml': SAMPLE_DECOMPOSITION,
      '.mpl/config.json': JSON.stringify({
        enforcement: { audit_residual: 'block' },
      }),
    });
    let exitCode = 0;
    let stdout;
    try {
      stdout = execFileSync('node', [CLI_PATH, tmp], { encoding: 'utf-8' });
    } catch (err) {
      exitCode = err.status;
      stdout = err.stdout?.toString() ?? '';
    }
    assert.equal(exitCode, 1, 'block policy must elevate fail to exit 1');
    const report = JSON.parse(stdout);
    assert.equal(report.verdict, 'fail');
  });
});

/* ────────────────────────── PR #136 review regressions ───────────────────── */

describe('PR #136 review regressions', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-f6-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  /* Codex HIGH ----------------------------------------------------------- */

  it('isLegacyContractMode returns true when user-contract.md is absent', () => {
    assert.equal(isLegacyContractMode(tmp), true);
    scaffold(tmp, { '.mpl/requirements/user-contract.md': SAMPLE_USER_CONTRACT });
    assert.equal(isLegacyContractMode(tmp), false);
  });

  it('Codex HIGH: legacy mode (no user-contract.md) suppresses dangling covers', () => {
    // Decomposition claims UC-01 but no user-contract.md exists — pre-fix
    // emitted a dangling-covers fail; post-fix mirrors mpl-require-covers
    // graceful-skip semantics and returns no surfaces.
    scaffold(tmp, {
      '.mpl/mpl/decomposition.yaml': `phases:
  - id: phase-1
    covers: [UC-01]
    impact:
      create:
        - path: src/a.ts
`,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, { now: 'NOW' });
    assert.equal(report.contract_mode, 'legacy_skip');
    assert.equal(report.verdict, 'pass');
    assert.equal(report.summary.dangling_covers, 0);
    assert.equal(report.summary.missing_covers, 0);
  });

  it('Codex HIGH: findMissingCovers honours legacy:true opts flag', () => {
    const ucs = []; // pretend the file is absent
    const phases = [{ id: 'p1', covers: ['UC-01', 'UC-99'], impact_files: [] }];
    const { uncovered, dangling } = findMissingCovers(ucs, phases, { legacy: true });
    assert.deepStrictEqual(uncovered, []);
    assert.deepStrictEqual(dangling, []);
  });

  it('Codex HIGH: enforced mode (file present + empty user_cases) still surfaces dangling', () => {
    // Distinguish "no contract file" (legacy_skip) from "empty contract" —
    // the latter is an explicit author choice and dangling claims are real.
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': `# UC

\`\`\`yaml
schema_version: 1
user_cases: []
\`\`\`
`,
      '.mpl/mpl/decomposition.yaml': `phases:
  - id: phase-1
    covers: [UC-01]
    impact:
      create:
        - path: src/a.ts
`,
    });
    const report = runCodexAudit(tmp, REAL_PLUGIN_ROOT, { now: 'NOW' });
    assert.equal(report.contract_mode, 'enforced');
    assert.equal(report.verdict, 'fail');
    assert.equal(report.summary.dangling_covers, 1);
  });

  /* Codex MEDIUM --------------------------------------------------------- */

  it('Codex MEDIUM: drift probe sees unstaged created files (finalize-time scenario)', () => {
    // F6 runs before Git Master commit, so the impl is in the working tree
    // unstaged. Pre-fix probe chain (merge-base / HEAD~20 / --cached) all
    // missed unstaged content; declared impact reported as `unimplemented`
    // even though the file existed.
    execSync('git init -q', { cwd: tmp });
    execSync('git config user.email a@b.c', { cwd: tmp });
    execSync('git config user.name t', { cwd: tmp });
    writeFileSync(join(tmp, 'README.md'), '# init');
    execSync('git add README.md && git commit -q -m init', { cwd: tmp });

    scaffold(tmp, {
      'src/a.ts': 'export const a = 1;\n',
    });
    const phases = [{ id: 'p1', covers: ['internal'], impact_files: ['src/a.ts'] }];
    const drift = findScopeDrift(tmp, phases);
    assert.ok(!drift.unimplemented.includes('src/a.ts'),
      `unstaged created file must not be reported as unimplemented; got ${JSON.stringify(drift)}`);
  });

  it('Codex MEDIUM: drift probe sees staged-but-uncommitted changes', () => {
    execSync('git init -q', { cwd: tmp });
    execSync('git config user.email a@b.c', { cwd: tmp });
    execSync('git config user.name t', { cwd: tmp });
    writeFileSync(join(tmp, 'README.md'), '# init');
    execSync('git add README.md && git commit -q -m init', { cwd: tmp });

    scaffold(tmp, { 'src/b.ts': 'export const b = 2;\n' });
    execSync('git add src/b.ts', { cwd: tmp });
    const phases = [{ id: 'p1', covers: ['internal'], impact_files: ['src/b.ts'] }];
    const drift = findScopeDrift(tmp, phases);
    assert.ok(!drift.unimplemented.includes('src/b.ts'));
  });

  /* Claude #1 + #2 indent fragility ------------------------------------- */

  it('Claude #1: parseDecompositionPhases tolerates deeper-indented phases', () => {
    // Future schema may wrap phases under a meta layer (e.g. `task:`).
    // Pre-fix `^  - id:` (exact 2-space) silently returned [].
    scaffold(tmp, {
      '.mpl/mpl/decomposition.yaml': `task:
  phases:
    - id: phase-1
      covers: [internal]
      impact:
        create:
          - path: src/x.ts
        modify:
          - path: src/y.ts
`,
    });
    const phases = parseDecompositionPhases(tmp);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].id, 'phase-1');
    assert.deepStrictEqual(phases[0].impact_files.sort(), ['src/x.ts', 'src/y.ts']);
  });

  /* Claude #3 indent tolerance for user_cases --------------------------- */

  it('Claude #3: enumerateIncludedUserCases tolerates indented user_cases section', () => {
    // YAML inside a markdown fence with author-added indent.
    scaffold(tmp, {
      '.mpl/requirements/user-contract.md': `# UC

\`\`\`yaml
metadata:
  schema_version: 1

  user_cases:
    - id: "UC-01"
      title: "Indented case"
      status: "included"
      covers_pp: ["PP-A"]
\`\`\`
`,
    });
    const ucs = enumerateIncludedUserCases(tmp);
    assert.equal(ucs.length, 1);
    assert.equal(ucs[0].id, 'UC-01');
  });
});

