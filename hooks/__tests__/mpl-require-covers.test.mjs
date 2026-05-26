import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  targetsDecompositionFile,
  parsePhaseCovers,
  validatePhase,
  computeInternalRatio,
} from '../mpl-require-covers.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-covers.mjs');

describe('targetsDecompositionFile', () => {
  it('matches .mpl/mpl/decomposition.yaml', () => {
    assert.equal(
      targetsDecompositionFile('/repo/.mpl/mpl/decomposition.yaml'),
      true,
    );
  });
  it('does not match unrelated files', () => {
    assert.equal(
      targetsDecompositionFile('/repo/.mpl/mpl/chain-assignment.yaml'),
      false,
    );
    assert.equal(
      targetsDecompositionFile('/repo/.mpl/requirements/user-contract.md'),
      false,
    );
  });
  it('returns false for null/empty', () => {
    assert.equal(targetsDecompositionFile(null), false);
    assert.equal(targetsDecompositionFile(''), false);
  });
});

describe('parsePhaseCovers', () => {
  it('parses inline array form', () => {
    const yaml = `
phases:
  - id: "phase-1"
    covers: [UC-01, UC-02]
  - id: "phase-2"
    covers: ["internal"]
`;
    const out = parsePhaseCovers(yaml);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].covers, ['UC-01', 'UC-02']);
    assert.deepEqual(out[1].covers, ['internal']);
  });

  it('parses block list form', () => {
    const yaml = `
phases:
  - id: "phase-1"
    name: "x"
    covers:
      - "UC-01"
      - "UC-05"
    impact:
      create: []
  - id: "phase-2"
    covers:
      - internal
`;
    const out = parsePhaseCovers(yaml);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].covers, ['UC-01', 'UC-05']);
    assert.deepEqual(out[1].covers, ['internal']);
  });

  it('records null covers when field missing', () => {
    const yaml = `
phases:
  - id: "phase-1"
    name: "no covers"
    impact:
      create: []
`;
    const out = parsePhaseCovers(yaml);
    assert.equal(out.length, 1);
    assert.equal(out[0].covers, null);
  });

  it('records empty array when covers is []', () => {
    const yaml = `
phases:
  - id: "phase-1"
    covers: []
`;
    const out = parsePhaseCovers(yaml);
    assert.deepEqual(out[0].covers, []);
  });

  it('handles null/empty input', () => {
    assert.deepEqual(parsePhaseCovers(null), []);
    assert.deepEqual(parsePhaseCovers(''), []);
  });
});

describe('validatePhase', () => {
  it('flags missing covers', () => {
    const issues = validatePhase({ id: 'phase-1', covers: null }, { allowLegacy: false });
    assert.ok(issues.some((i) => i.kind === 'missing'));
  });
  it('flags empty covers', () => {
    const issues = validatePhase({ id: 'phase-1', covers: [] }, { allowLegacy: false });
    assert.ok(issues.some((i) => i.kind === 'empty'));
  });
  it('accepts valid UC-NN', () => {
    const issues = validatePhase({ id: 'p', covers: ['UC-01', 'UC-15'] }, { allowLegacy: false });
    assert.equal(issues.length, 0);
  });
  it('accepts internal escape', () => {
    const issues = validatePhase({ id: 'p', covers: ['internal'] }, { allowLegacy: false });
    assert.equal(issues.length, 0);
  });
  it('rejects invalid entry', () => {
    const issues = validatePhase({ id: 'p', covers: ['bogus'] }, { allowLegacy: false });
    assert.ok(issues.some((i) => i.kind === 'invalid_entry' && i.entry === 'bogus'));
  });
  it('rejects single-digit UC (requires UC-NN 2+ digits)', () => {
    const issues = validatePhase({ id: 'p', covers: ['UC-1'] }, { allowLegacy: false });
    assert.ok(issues.some((i) => i.kind === 'invalid_entry'));
  });
  it('legacy mode downgrades invalid entries but still blocks missing/empty', () => {
    const legacyOk = validatePhase({ id: 'p', covers: ['bogus'] }, { allowLegacy: true });
    assert.equal(legacyOk.length, 0);
    const legacyMissing = validatePhase({ id: 'p', covers: null }, { allowLegacy: true });
    assert.ok(legacyMissing.some((i) => i.kind === 'missing'));
  });
});

describe('computeInternalRatio', () => {
  it('returns 0 for all-UC phases', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['UC-01'] },
      { id: 'b', covers: ['UC-02'] },
    ]);
    assert.equal(r, 0);
  });
  it('returns 1 for all-internal phases', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['internal'] },
      { id: 'b', covers: ['internal'] },
    ]);
    assert.equal(r, 1);
  });
  it('returns mixed ratio', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['UC-01'] },
      { id: 'b', covers: ['internal'] },
      { id: 'c', covers: ['internal'] },
      { id: 'd', covers: ['UC-02'] },
    ]);
    assert.equal(r, 0.5);
  });
  it('phase with UC + internal mix counts as NOT internal-only', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['UC-01', 'internal'] },
      { id: 'b', covers: ['internal'] },
    ]);
    assert.equal(r, 0.5);
  });
  it('ignores phases with null/empty covers', () => {
    const r = computeInternalRatio([
      { id: 'a', covers: ['UC-01'] },
      { id: 'b', covers: null },
      { id: 'c', covers: [] },
    ]);
    assert.equal(r, 0);
  });
  it('returns 0 when no valid phases', () => {
    assert.equal(computeInternalRatio([]), 0);
    assert.equal(computeInternalRatio([{ id: 'a', covers: null }]), 0);
  });
});

describe('mpl-require-covers hook integration', () => {
  it('blocks MultiEdit writes to decomposition.yaml with missing covers', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-covers-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      mkdirSync(join(tmp, '.mpl', 'requirements'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase1-decompose',
      }));
      writeFileSync(join(tmp, '.mpl', 'requirements', 'user-contract.md'), 'user_cases: []\n');

      const input = {
        cwd: tmp,
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: '.mpl/mpl/decomposition.yaml',
          edits: [{
            old_string: 'old',
            new_string: 'phases:\n  - id: phase-1\n    name: Missing covers\n',
          }],
        },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.decision, 'block');
      assert.match(r.reason, /covers field missing/);
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.blocked_by_hook, 'mpl-require-covers');
      assert.equal(state.blocked_artifact, '.mpl/mpl/decomposition.yaml');
      assert.equal(state.block_code, 'covers_schema_violation');
      assert.equal(state.retry_context.issue_count, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('clears matching blocked_hook when covers pass on retry', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-covers-clear-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      mkdirSync(join(tmp, '.mpl', 'requirements'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'mpl-decompose',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-covers',
        blocked_phase: 'mpl-decompose',
        blocked_artifact: '.mpl/mpl/decomposition.yaml',
        block_code: 'covers_schema_violation',
        block_reason: 'missing covers',
        resume_instruction: 'add covers',
        retry_context: { target: '.mpl/mpl/decomposition.yaml' },
        blocked_at: '2026-05-26T00:00:00Z',
      }));
      writeFileSync(join(tmp, '.mpl', 'requirements', 'user-contract.md'), 'user_cases: []\n');

      const input = {
        cwd: tmp,
        tool_name: 'Write',
        tool_input: {
          file_path: '.mpl/mpl/decomposition.yaml',
          content: 'phases:\n  - id: phase-1\n    covers: [UC-01]\n',
        },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, true);
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      assert.equal(state.session_status, null);
      assert.equal(state.blocked_by_hook, null);
      assert.equal(state.retry_context, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
