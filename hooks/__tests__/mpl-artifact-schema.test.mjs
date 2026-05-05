import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  matchArtifactSchema,
  validateArtifactFile,
  validateAgainstSchema,
  hasKey,
  ARTIFACT_SCHEMAS,
} from '../lib/mpl-artifact-schema.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

// PR #135 nit (Claude): use the live schema_version constant in
// fixtures so a future bump doesn't trigger a migration mid-test.
// Same pattern as #133's mpl-state-invariant fixtures.
const SCHEMA_V = CURRENT_SCHEMA_VERSION;

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-artifact-schema.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-art-'));
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
  // Make MPL "active" so the hook proceeds.
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: SCHEMA_V,
    current_phase: 'phase2-sprint',
    started_at: '2026-05-05T01:00:00Z',
  }));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/* ───────────────────── lib unit ─────────────────────────────── */

describe('matchArtifactSchema', () => {
  it('matches decomposition.yaml under .mpl/mpl/', () => {
    assert.equal(matchArtifactSchema('.mpl/mpl/decomposition.yaml')?.artifact, 'decomposition');
    assert.equal(matchArtifactSchema('.mpl/mpl/decomposition.yml')?.artifact, 'decomposition');
  });

  it('matches state-summary.md under any phase folder', () => {
    assert.equal(matchArtifactSchema('.mpl/mpl/phases/phase-1/state-summary.md')?.artifact, 'state-summary');
    assert.equal(matchArtifactSchema('.mpl/mpl/phases/phase-12/state-summary.md')?.artifact, 'state-summary');
  });

  it('matches verification.md per phase', () => {
    assert.equal(matchArtifactSchema('.mpl/mpl/phases/phase-3/verification.md')?.artifact, 'verification');
  });

  it('matches pivot-points.md', () => {
    assert.equal(matchArtifactSchema('.mpl/pivot-points.md')?.artifact, 'pivot-points');
  });

  it('matches user-contract.md under .mpl/requirements/', () => {
    assert.equal(matchArtifactSchema('.mpl/requirements/user-contract.md')?.artifact, 'user-contract');
  });

  it('returns null for unrelated paths', () => {
    assert.equal(matchArtifactSchema('src/foo.ts'), null);
    assert.equal(matchArtifactSchema('.mpl/state.json'), null);
    assert.equal(matchArtifactSchema(''), null);
    assert.equal(matchArtifactSchema(null), null);
  });
});

describe('hasKey', () => {
  it('detects markdown headings (case + style insensitive)', () => {
    assert.equal(hasKey('## Status', 'status', 'markdown'), true);
    assert.equal(hasKey('### next phase context', 'next_phase_context', 'markdown'), true);
    assert.equal(hasKey('## Files-Changed', 'files_changed', 'markdown'), true);
    assert.equal(hasKey('# verification', 'verification', 'markdown'), true);
  });

  it('detects bold labels', () => {
    assert.equal(hasKey('Some prose, then **PP_id**: PP-01', 'pp_id', 'markdown'), true);
  });

  it('detects key: lines', () => {
    assert.equal(hasKey('status: completed\n', 'status', 'markdown'), true);
  });

  it('detects yaml top-level keys', () => {
    assert.equal(hasKey('phase_id: phase-1\nimpact_scope: src/\n', 'phase_id', 'yaml'), true);
  });

  it('detects yaml list-element keys (- key:)', () => {
    assert.equal(hasKey('phases:\n  - phase_id: phase-1\n    covers: [UC-1]\n', 'phase_id', 'yaml'), true);
    assert.equal(hasKey('phases:\n  - phase_id: phase-1\n    covers: [UC-1]\n', 'covers', 'yaml'), true);
  });

  it('returns false when key absent', () => {
    assert.equal(hasKey('## Status\n', 'next_phase_context', 'markdown'), false);
  });
});

describe('validateAgainstSchema', () => {
  it('flags all missing required keys', () => {
    const schema = ARTIFACT_SCHEMAS.find((s) => s.artifact === 'state-summary');
    const r = validateAgainstSchema('## status\n## decisions\n', schema);
    assert.equal(r.valid, false);
    assert.deepEqual(r.missing.sort(), ['files_changed', 'next_phase_context', 'verification'].sort());
  });

  it('passes when every required key present', () => {
    const schema = ARTIFACT_SCHEMAS.find((s) => s.artifact === 'state-summary');
    const content = '## Status\n## Files Changed\n## Verification\n## Decisions\n## Next Phase Context\n';
    const r = validateAgainstSchema(content, schema);
    assert.equal(r.valid, true);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.missingAnyOf, []);
  });

  it('honors anyOf groups (verification: command|file|grep + result|exit_code)', () => {
    const schema = ARTIFACT_SCHEMAS.find((s) => s.artifact === 'verification');
    // Only command + result → satisfies both anyOf groups
    const ok = '## criterion\n## evidence_type\n## command: pytest\n## result: pass\n';
    assert.equal(validateAgainstSchema(ok, schema).valid, true);
    // Missing the result/exit_code group entirely
    const partial = '## criterion\n## evidence_type\n## command: pytest\n';
    const r = validateAgainstSchema(partial, schema);
    assert.equal(r.valid, false);
    assert.equal(r.missing.length, 0, 'required keys all satisfied');
    assert.equal(r.missingAnyOf.length, 1);
    assert.deepEqual(r.missingAnyOf[0], ['result', 'exit_code']);
  });
});

describe('validateArtifactFile', () => {
  it('returns null for out-of-scope paths', () => {
    assert.equal(validateArtifactFile('src/foo.ts', 'whatever'), null);
  });

  it('flags missing keys with the artifact name', () => {
    const r = validateArtifactFile('.mpl/pivot-points.md', '## Some Heading\n');
    assert.equal(r.artifact, 'pivot-points');
    assert.equal(r.valid, false);
    assert.deepEqual(r.missing.sort(), ['PP_id', 'constraint', 'source', 'status'].sort());
  });

  it('PR #135 review #1: validates the actual decomposer output shape (id/scope/impact, not phase_id/impact_scope)', () => {
    // Reproducer from the Codex review: a decomposition.yaml that
    // exactly matches `agents/mpl-decomposer.md` <Output_Schema>. The
    // pre-fix schema required `phase_id` + `impact_scope` and rejected
    // every valid decomposer output.
    const content =
`architecture_anchor:
  tech_stack: [typescript]
  directory_pattern: src/
  naming_convention: camelCase
  key_decisions: []
phases:
  - id: "phase-1"
    name: "Implement auth"
    phase_domain: api
    pp_proximity: pp_core
    scope: "Add login API"
    covers: [UC-01]
    impact:
      create:
        - path: src/auth.ts
          description: auth API
      modify: []
      affected_tests: []
    interface_contract:
      requires: []
      produces: []
      contract_files: []
    success_criteria:
      - type: test
        command: npm test
`;
    const r = validateArtifactFile('.mpl/mpl/decomposition.yaml', content);
    assert.equal(r.artifact, 'decomposition');
    assert.equal(r.valid, true, `expected valid; missing=${JSON.stringify(r.missing)}`);
    assert.deepEqual(r.missing, []);
  });

  it('PR #135 review #1: still rejects decomposition.yaml missing one required key', () => {
    // Same shape as above but `interface_contract` removed → invalid.
    const content =
`phases:
  - id: "phase-1"
    scope: "Add login API"
    covers: [UC-01]
    impact: { create: [], modify: [], affected_tests: [] }
    success_criteria: []
`;
    const r = validateArtifactFile('.mpl/mpl/decomposition.yaml', content);
    assert.equal(r.valid, false);
    assert.ok(r.missing.includes('interface_contract'));
  });
});

/* ──────────────── PostToolUse hook integration ──────────────── */

describe('mpl-artifact-schema PostToolUse hook (P0-K)', () => {
  function runHook({ toolName = 'Write', filePath, content }) {
    if (content !== undefined) {
      const abs = join(tmp, filePath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: { file_path: filePath },
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    return JSON.parse(out);
  }

  it('silent for non-artifact paths', () => {
    const r = runHook({ filePath: 'src/foo.ts', content: 'export {};\n' });
    assert.equal(r.continue, true);
    assert.equal(r.suppressOutput, true);
  });

  it('silent for valid artifact', () => {
    const content = '## Status\n## Files Changed\n## Verification\n## Decisions\n## Next Phase Context\n';
    const r = runHook({ filePath: '.mpl/mpl/phases/phase-1/state-summary.md', content });
    assert.equal(r.continue, true);
    assert.equal(r.suppressOutput, true);
  });

  it('default warn → systemMessage with missing sections', () => {
    const r = runHook({
      filePath: '.mpl/mpl/phases/phase-1/state-summary.md',
      content: '## status\n## decisions\n',
    });
    assert.equal(r.continue, true);
    assert.match(r.systemMessage || '', /artifact schema advisory/);
    assert.match(r.systemMessage || '', /missing required:/);
    assert.match(r.systemMessage || '', /files_changed/);
  });

  it('block when enforcement.missing_artifact_schema = "block"', () => {
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
      schema_version: SCHEMA_V,
      current_phase: 'phase2-sprint',
      enforcement: { missing_artifact_schema: 'block' },
    }));
    const r = runHook({
      filePath: '.mpl/pivot-points.md',
      content: '## Random heading\n',
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason || '', /artifact schema violation/);
    assert.match(r.reason || '', /PP_id/);
  });

  it('off → silent + signal logged', () => {
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
      schema_version: SCHEMA_V,
      current_phase: 'phase2-sprint',
      enforcement: { missing_artifact_schema: 'off' },
    }));
    const r = runHook({
      filePath: '.mpl/pivot-points.md',
      content: '## Heading\n',
    });
    assert.equal(r.continue, true);
    assert.equal(r.suppressOutput, true);
    // Signal still logged for audit trail.
    const signalsPath = join(tmp, '.mpl', 'signals', 'artifact-schema-hits.jsonl');
    assert.ok(existsSync(signalsPath), 'signal logged even when off');
    const line = readFileSync(signalsPath, 'utf-8').trim();
    const entry = JSON.parse(line);
    assert.equal(entry.action, 'off');
    assert.equal(entry.valid, false);
  });

  it('silent when MPL inactive (no state.json)', () => {
    rmSync(join(tmp, '.mpl', 'state.json'));
    rmSync(join(tmp, '.mpl'), { recursive: true });
    const r = runHook({
      filePath: '.mpl/pivot-points.md',
      content: '## Garbage\n',
    });
    assert.equal(r.continue, true);
    assert.equal(r.suppressOutput, true);
  });

  it('CLI mode walks the workspace and reports per-file verdicts', () => {
    // Two phase folders, one valid + one invalid state-summary; one
    // valid pivot-points; one absent file is silently skipped.
    const ss = '## Status\n## Files Changed\n## Verification\n## Decisions\n## Next Phase Context\n';
    mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
    mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'state-summary.md'), ss);
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2', 'state-summary.md'), '## status only\n');
    writeFileSync(join(tmp, '.mpl', 'pivot-points.md'),
      '## PP_id\n## constraint\n## status\n## source\n');

    let exit = 0;
    let stdout = '';
    try {
      stdout = execFileSync('node', [HOOK_PATH, tmp], { encoding: 'utf-8' });
    } catch (e) {
      exit = e.status ?? -1;
      stdout = e.stdout?.toString?.() ?? '';
    }
    assert.equal(exit, 1, 'exit 1 when at least one file is invalid');
    const r = JSON.parse(stdout);
    assert.equal(r.totals.files, 3);
    assert.equal(r.totals.invalid, 1);
    const phase2 = r.results.find((x) => x.file.endsWith('phase-2/state-summary.md'));
    assert.equal(phase2.valid, false);
    assert.ok(phase2.missing.includes('files_changed'));
  });

  it('CLI mode exits 0 when every artifact is valid (or absent)', () => {
    // Empty workspace — no artifacts → totals.files=0, exit 0.
    const stdout = execFileSync('node', [HOOK_PATH, tmp], { encoding: 'utf-8' });
    const r = JSON.parse(stdout);
    assert.equal(r.totals.files, 0);
    assert.equal(r.totals.invalid, 0);
  });

  it('CLI mode exit 2 when the workspace path does not exist', () => {
    let exit = 0;
    try { execFileSync('node', [HOOK_PATH, '/nonexistent/path/zz']); }
    catch (e) { exit = e.status ?? -1; }
    assert.equal(exit, 2);
  });

  it('handles MultiEdit with multiple file_path entries', () => {
    const stateSummary = '## Status\n## Files Changed\n## Verification\n## Decisions\n## Next Phase Context\n';
    mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'state-summary.md'), stateSummary);
    writeFileSync(join(tmp, '.mpl', 'pivot-points.md'), '## Bad\n');
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: 'PostToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        edits: [
          { file_path: '.mpl/mpl/phases/phase-1/state-summary.md' },
          { file_path: '.mpl/pivot-points.md' },
        ],
      },
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    const r = JSON.parse(out);
    // Only pivot-points.md is invalid.
    assert.match(r.systemMessage || '', /pivot-points\.md.*PP_id/);
    assert.doesNotMatch(r.systemMessage || '', /state-summary\.md/);
  });
});
