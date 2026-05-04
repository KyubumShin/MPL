import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  enumerateDoctorSources,
  detectSelfExemption,
  validateScopeManifest,
  auditDoctorSelf,
  inverseAudit,
  runMetaSelf,
} from '../lib/mpl-meta-self.mjs';

const __filename = fileURLToPath(import.meta.url);
const CLI_PATH = join(dirname(__filename), '..', 'mpl-doctor-meta-self.mjs');
const REAL_PLUGIN_ROOT = join(dirname(__filename), '..', '..');

/* Synthetic plugin root scaffold ------------------------------------------- */

function scaffold(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

const MIN_REGISTRY = `# Anti-patterns

## Scope (file extensions)

\`\`\`scope
.mjs .ts .py
\`\`\`

\`\`\`scope-excluded
.md
\`\`\`

## Patterns

### D1.a · Nullish-empty-string default

- **id**: \`D1.a\`
- **category**: \`fallback-poison\`
- **severity**: \`warn\`
- **escalation**: \`tier_3_block_in: verification-result-LHS\`
- **rationale**: synthetic.
- **ground-truth count**: 1 (test fixture)

\`\`\`regex
\\?\\?\\s*['"]\\s*['"]
\`\`\`

\`\`\`permitted-when
None.
\`\`\`
`;

/* enumerateDoctorSources --------------------------------------------------- */

describe('enumerateDoctorSources', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-meta-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns empty when nothing exists', () => {
    assert.deepStrictEqual(enumerateDoctorSources(tmp), []);
  });

  it('picks up agents/mpl-doctor.md', () => {
    scaffold(tmp, { 'agents/mpl-doctor.md': '# doctor' });
    assert.deepStrictEqual(enumerateDoctorSources(tmp), ['agents/mpl-doctor.md']);
  });

  it('picks up skills/mpl-doctor/SKILL.md (PR #127 review #1 fix)', () => {
    scaffold(tmp, { 'skills/mpl-doctor/SKILL.md': '# doctor skill' });
    assert.ok(enumerateDoctorSources(tmp).includes('skills/mpl-doctor/SKILL.md'));
  });

  it('discovers hooks/mpl-doctor*.mjs and hooks/lib/mpl-doctor*.mjs', () => {
    scaffold(tmp, {
      'agents/mpl-doctor.md': '# doctor',
      'hooks/mpl-doctor-runner.mjs': '// runner',
      'hooks/lib/mpl-doctor-helpers.mjs': '// helpers',
      'hooks/mpl-other.mjs': '// unrelated',
    });
    const out = enumerateDoctorSources(tmp);
    assert.ok(out.includes('agents/mpl-doctor.md'));
    assert.ok(out.includes('hooks/mpl-doctor-runner.mjs'));
    assert.ok(out.includes('hooks/lib/mpl-doctor-helpers.mjs'));
    assert.ok(!out.includes('hooks/mpl-other.mjs'));
  });
});

/* detectSelfExemption ------------------------------------------------------ */

describe('detectSelfExemption', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-meta-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('detects code-shape conditional skipping doctor', () => {
    scaffold(tmp, {
      'hooks/mpl-doctor-runner.mjs':
        "if (file.endsWith('mpl-doctor.md')) { return; }\n",
    });
    const hits = detectSelfExemption(tmp);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'self-exempt-conditional');
  });

  it('detects array filter rejecting doctor file', () => {
    scaffold(tmp, {
      'hooks/mpl-doctor-runner.mjs':
        "files.filter(f => f !== 'agents/mpl-doctor.md')\n",
    });
    const hits = detectSelfExemption(tmp);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'self-exempt-filter-out');
  });

  it('detects deny-list assignment', () => {
    scaffold(tmp, {
      'hooks/mpl-doctor-runner.mjs':
        "const exclude = ['agents/mpl-doctor.md'];\n",
    });
    const hits = detectSelfExemption(tmp);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'self-exempt-deny-list');
  });

  it('detects negative-regex lookahead naming doctor (Pattern 5 shape)', () => {
    scaffold(tmp, {
      'hooks/mpl-doctor-runner.mjs':
        "const r = /(?!.*mpl-doctor)/;\n",
    });
    const hits = detectSelfExemption(tmp);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'self-exempt-negative-regex');
  });

  it('does NOT match prose mentioning the patterns', () => {
    scaffold(tmp, {
      'agents/mpl-doctor.md':
        '- explicit self-exclude regex inside doctor source must be flagged\n'
        + '- doctor must skip placeholder text (this is documentation)\n',
    });
    const hits = detectSelfExemption(tmp);
    // Plain English prose inside doctor markdown should not trip the
    // narrow code-shape patterns.
    assert.strictEqual(hits.length, 0);
  });

  it('does NOT match code-shaped examples wrapped in inline backtick prose (PR #127 issue #1)', () => {
    // Category 14 itself documents `if (file.endsWith('mpl-doctor.md')) skip`
    // as an example. Without fenced-code-only scanning of markdown, the
    // detector self-matches every audit run.
    scaffold(tmp, {
      'agents/mpl-doctor.md':
        '### Category 14: Meta-Self Audit\n'
        + '- example self-exemption shape: `if (file.endsWith(\'mpl-doctor.md\')) skip`\n'
        + '- another: `files.filter(f => f !== \'agents/mpl-doctor.md\')` form\n',
    });
    const hits = detectSelfExemption(tmp);
    assert.strictEqual(hits.length, 0);
  });

  it('DOES match code-shaped patterns inside fenced code blocks of markdown', () => {
    scaffold(tmp, {
      'agents/mpl-doctor.md':
        '```js\nif (file.endsWith(\'mpl-doctor.md\')) return;\n```\n',
    });
    const hits = detectSelfExemption(tmp);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'self-exempt-conditional');
  });
});

/* validateScopeManifest ---------------------------------------------------- */

describe('validateScopeManifest', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-meta-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('flags categories without **Scope**', () => {
    scaffold(tmp, {
      'agents/mpl-doctor.md': `
### Category 1: Plugin Structure
- **Scope**: \`.claude-plugin/plugin.json\`
- check.

### Category 2: Hooks
- check.

### Category 3: Skills
- **Scope**: \`skills/**/SKILL.md\`
- check.
`,
    });
    const r = validateScopeManifest(tmp);
    assert.strictEqual(r.categories.length, 3);
    assert.deepStrictEqual(r.missing.map((m) => m.id), ['2']);
  });

  it('reports empty when no doctor file present', () => {
    const r = validateScopeManifest(tmp);
    assert.strictEqual(r.categories.length, 0);
    assert.match(r.error || '', /agents\/mpl-doctor\.md not found/);
  });

  it('handles all categories with scope', () => {
    scaffold(tmp, {
      'agents/mpl-doctor.md': `
### Category 1: A
- **Scope**: \`x/**\`

### Category 2: B
- **Scope**: \`y/**\`
`,
    });
    const r = validateScopeManifest(tmp);
    assert.strictEqual(r.missing.length, 0);
    assert.strictEqual(r.categories[0].scopeText, '`x/**`');
  });
});

/* auditDoctorSelf ---------------------------------------------------------- */

describe('auditDoctorSelf', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-meta-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('flags D1.a violation in code block of doctor markdown', () => {
    scaffold(tmp, {
      'commands/references/anti-patterns.md': MIN_REGISTRY,
      'agents/mpl-doctor.md': '# doctor\n\n```js\nconst x = obj.foo ?? "";\n```\n',
    });
    const hits = auditDoctorSelf(tmp);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'D1.a');
    assert.strictEqual(hits[0].file, 'agents/mpl-doctor.md');
  });

  it('does NOT flag D1.a inline reference outside code block (prose)', () => {
    scaffold(tmp, {
      'commands/references/anti-patterns.md': MIN_REGISTRY,
      'agents/mpl-doctor.md':
        '# doctor\n\nThe `?? ""` pattern is a known anti-pattern (D1.a).\n',
    });
    const hits = auditDoctorSelf(tmp);
    assert.strictEqual(hits.length, 0);
  });

  it('flags violations in hooks/mpl-doctor*.mjs source (no code-block stripping)', () => {
    scaffold(tmp, {
      'commands/references/anti-patterns.md': MIN_REGISTRY,
      'hooks/mpl-doctor-runner.mjs': "const x = obj.foo ?? '';\n",
    });
    const hits = auditDoctorSelf(tmp);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].file, 'hooks/mpl-doctor-runner.mjs');
  });

  it('returns empty when no registry is found', () => {
    scaffold(tmp, { 'agents/mpl-doctor.md': '# doctor' });
    assert.deepStrictEqual(auditDoctorSelf(tmp), []);
  });
});

/* inverseAudit ------------------------------------------------------------- */

describe('inverseAudit', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-meta-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('flags hits in scripts/', () => {
    scaffold(tmp, {
      'commands/references/anti-patterns.md': MIN_REGISTRY,
      'scripts/build.mjs': "const x = obj.foo ?? '';\n",
    });
    const hits = inverseAudit(tmp);
    assert.ok(hits.length >= 1);
    assert.match(hits[0].file, /^scripts\/build\.mjs$/);
  });

  it('flags hits in nested directory under agents/ (not just shallow)', () => {
    scaffold(tmp, {
      'commands/references/anti-patterns.md': MIN_REGISTRY,
      'agents/sub/helper.mjs': "const x = obj.foo ?? '';\n",
    });
    const hits = inverseAudit(tmp);
    assert.ok(hits.length >= 1);
    assert.match(hits[0].file, /agents\/sub\/helper\.mjs/);
  });

  it('skips non-source extensions (.json, .yaml)', () => {
    scaffold(tmp, {
      'commands/references/anti-patterns.md': MIN_REGISTRY,
      'scripts/config.json': '{"x": "?? \'\'"}\n',
    });
    const hits = inverseAudit(tmp);
    assert.strictEqual(hits.length, 0);
  });

  it('returns empty when scope dirs are absent', () => {
    scaffold(tmp, {
      'commands/references/anti-patterns.md': MIN_REGISTRY,
    });
    assert.deepStrictEqual(inverseAudit(tmp), []);
  });
});

/* runMetaSelf + CLI integration ------------------------------------------- */

describe('runMetaSelf aggregator', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-meta-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('aggregates all four sub-checks', () => {
    scaffold(tmp, {
      'commands/references/anti-patterns.md': MIN_REGISTRY,
      'agents/mpl-doctor.md':
        '### Category 1: A\n- **Scope**: `x`\n\n### Category 2: B\n- check.\n',
      'hooks/mpl-doctor-runner.mjs':
        "if (path.endsWith('mpl-doctor.md')) return;\n",
      'scripts/legacy.mjs': "const x = obj.foo ?? '';\n",
    });
    const r = runMetaSelf(tmp);
    assert.ok(r.doctor_sources.length >= 2);
    assert.strictEqual(r.self_exemption_hits.length, 1);
    assert.deepStrictEqual(r.scope_manifest.missing.map((m) => m.id), ['2']);
    assert.ok(r.inverse_audit_hits.length >= 1);
  });
});

describe('mpl-doctor-meta-self CLI', () => {
  it('emits valid JSON for the real plugin root (self-run)', () => {
    const out = execFileSync('node', [CLI_PATH, REAL_PLUGIN_ROOT], { encoding: 'utf-8' });
    const r = JSON.parse(out);
    assert.ok(Array.isArray(r.doctor_sources));
    assert.ok(Array.isArray(r.self_exemption_hits));
    assert.ok(Array.isArray(r.anti_pattern_hits));
    assert.ok(r.scope_manifest && Array.isArray(r.scope_manifest.categories));
    assert.ok(Array.isArray(r.inverse_audit_hits));
  });

  it('real plugin root self-run is CLEAN (PR #127 issue #1 regression guard)', () => {
    // Beyond array-type checks: F4 must also keep the actual MPL plugin clean.
    // Otherwise doctor reports a permanent warning state on its own surface.
    const out = execFileSync('node', [CLI_PATH, REAL_PLUGIN_ROOT], { encoding: 'utf-8' });
    const r = JSON.parse(out);
    assert.strictEqual(
      r.self_exemption_hits.length,
      0,
      `self_exemption_hits must be empty; got: ${JSON.stringify(r.self_exemption_hits, null, 2)}`,
    );
    assert.strictEqual(
      r.scope_manifest.missing.length,
      0,
      `scope_manifest.missing must be empty; got: ${JSON.stringify(r.scope_manifest.missing, null, 2)}`,
    );
    // Sanity: declared Category 14 scope should be reflected in actual enumeration.
    assert.ok(r.doctor_sources.includes('agents/mpl-doctor.md'));
    assert.ok(r.doctor_sources.includes('skills/mpl-doctor/SKILL.md'));
  });

  it('exits non-zero when pluginRoot is missing', () => {
    let exit = 0;
    try {
      execFileSync('node', [CLI_PATH, '/definitely/not/a/path'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (e) {
      exit = e.status ?? -1;
    }
    assert.strictEqual(exit, 2);
  });
});
