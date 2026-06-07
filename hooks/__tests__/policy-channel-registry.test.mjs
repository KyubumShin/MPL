// Move #7 — policy/channel-registry.mjs tests.
//
// Verifies the new SSOT for .mpl/ channel allowlist + immutability dispatch:
//   - Glob compilation: `**`, `*`, `phase-*` capture, brace expansion,
//     posix normalization defeats `..` traversal.
//   - classifyChannel: forbidden > allowed > unregistered, outside_mpl.
//   - Immutability rules: always_after_first_write, baseline_renewal,
//     phase_lifecycle.phase_id_completed, completed_phase_block_unchanged.
//   - evaluateChannelWrite: composite decision + retryContext aggregation.
//   - Focus parameter: per-shim slice activation.
//   - CLI mode preservation via the new schema-bound enumerator.

import { test, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

import {
  compileGlob,
  classifyChannel,
  matchAllowedChannel,
  matchForbiddenPattern,
  evaluateImmutability,
  evaluateChannelWrite,
  loadChannelRegistry,
  normalizePosixPath,
} from '../lib/policy/channel-registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOKS_DIR = dirname(dirname(__filename));

function freshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-channel-reg-'));
  mkdirSync(join(dir, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(
    join(dir, '.mpl', 'state.json'),
    JSON.stringify({ current_phase: 'phase-1' }, null, 2),
  );
  return dir;
}

let tmp;
beforeEach(() => { tmp = freshWorkspace(); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ===========================================================================
// Glob compilation
// ===========================================================================

describe('compileGlob', () => {
  it('matches single-segment * within a path', () => {
    const re = compileGlob('.mpl/contracts/*.json');
    assert.equal(re.some((r) => r.test('.mpl/contracts/phase-1.json')), true);
    assert.equal(re.some((r) => r.test('.mpl/contracts/nested/file.json')), false);
  });

  it('matches ** for zero-or-more segments', () => {
    const re = compileGlob('.mpl/mpl/phase0/**');
    assert.equal(re.some((r) => r.test('.mpl/mpl/phase0/raw-scan.md')), true);
    assert.equal(re.some((r) => r.test('.mpl/mpl/phase0/sub/dir/file.yaml')), true);
    assert.equal(re.some((r) => r.test('.mpl/mpl/phase0')), true);
  });

  it('expands brace alternatives', () => {
    const re = compileGlob('.mpl/memory/{semantic,episodic}.md');
    assert.equal(re.some((r) => r.test('.mpl/memory/semantic.md')), true);
    assert.equal(re.some((r) => r.test('.mpl/memory/episodic.md')), true);
    assert.equal(re.some((r) => r.test('.mpl/memory/working.md')), false);
  });

  it('captures phase_id suffix from phase-* glob', () => {
    // The `phase-*` capture extracts the SUFFIX after `phase-` (the
    // evaluator prefixes back to `phase-N` when needed for state lookup).
    const re = compileGlob('.mpl/mpl/phases/phase-*/state-summary.md');
    const m = re.map((r) => r.exec('.mpl/mpl/phases/phase-7/state-summary.md')).find(Boolean);
    assert.ok(m);
    assert.equal(m.groups?.phase_id, '7');
  });
});

// ===========================================================================
// normalizePosixPath
// ===========================================================================

describe('normalizePosixPath', () => {
  it('collapses .. traversal so forgery cannot bypass forbidden gates', () => {
    assert.equal(normalizePosixPath('.mpl/foo/../scratchpad.md'), '.mpl/scratchpad.md');
  });

  it('strips ./ prefix', () => {
    assert.equal(normalizePosixPath('./.mpl/state.json'), '.mpl/state.json');
  });

  it('returns empty for non-strings', () => {
    assert.equal(normalizePosixPath(null), '');
    assert.equal(normalizePosixPath(undefined), '');
  });
});

// ===========================================================================
// classifyChannel
// ===========================================================================

describe('classifyChannel (default registry)', () => {
  const registry = loadChannelRegistry({});

  it('classifies an allowed channel', () => {
    const r = classifyChannel('.mpl/mpl/phases/phase-3/state-summary.md', registry);
    assert.equal(r.kind, 'allowed');
    assert.equal(r.entry.category, 'phase');
    assert.equal(r.entry.schema, 'state_summary');
    // captured suffix only — evaluator prefixes for state lookup.
    assert.equal(r.captures.phase_id, '3');
  });

  it('classifies a forbidden channel', () => {
    const r = classifyChannel('.mpl/scratchpad.md', registry);
    assert.equal(r.kind, 'forbidden');
    assert.equal(r.pattern, '.mpl/scratchpad*');
  });

  it('forbidden wins via traversal collapse', () => {
    // Even though the literal token is `.mpl/foo/../scratchpad.md`,
    // posix normalize collapses it before the forbidden gate runs.
    const r = classifyChannel('.mpl/foo/../scratchpad.md', registry);
    assert.equal(r.kind, 'forbidden');
  });

  it('classifies unregistered .mpl path as unregistered_channel', () => {
    const r = classifyChannel('.mpl/totally-new-thing.md', registry);
    assert.equal(r.kind, 'unregistered_channel');
  });

  it('classifies non-.mpl path as outside_mpl', () => {
    const r = classifyChannel('src/app.ts', registry);
    assert.equal(r.kind, 'outside_mpl');
  });

  it('matchAllowedChannel finds entry for state.json', () => {
    const entry = matchAllowedChannel('.mpl/state.json', registry);
    assert.ok(entry);
    assert.equal(entry.category, 'state');
  });

  it('matchForbiddenPattern returns null for allowed paths', () => {
    assert.equal(matchForbiddenPattern('.mpl/state.json', registry), null);
  });
});

// ===========================================================================
// evaluateImmutability — per evaluator
// ===========================================================================

describe('evaluateImmutability', () => {
  it('baseline_renewal_sentinel_absent: first write allowed', () => {
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/mpl/baseline.yaml',
      cwd: tmp,
      state: {},
      cfg: {},
      registry,
    });
    assert.equal(v.action, 'allow');
  });

  it('baseline_renewal_sentinel_absent: blocks rewrite when no sentinel', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), 'old: data\n');
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/mpl/baseline.yaml',
      cwd: tmp,
      state: {},
      cfg: {},
      registry,
    });
    assert.equal(v.action, 'block');
    assert.equal(v.code, 'baseline_immutable');
    assert.match(v.reason, /Baseline Guard/);
  });

  it('baseline_renewal_sentinel_absent: allows rewrite when sentinel exists', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), 'old: data\n');
    writeFileSync(join(tmp, '.mpl', 'mpl', '.baseline-renewal'), '');
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/mpl/baseline.yaml',
      cwd: tmp,
      state: {},
      cfg: {},
      registry,
    });
    assert.equal(v.action, 'allow');
  });

  it('always_after_first_write: blocks rewrite of pivot-points.md once it exists', () => {
    writeFileSync(join(tmp, '.mpl', 'pivot-points.md'), '## PP_id\n');
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/pivot-points.md',
      cwd: tmp,
      state: {},
      cfg: {},
      registry,
    });
    assert.equal(v.action, 'block');
    assert.match(v.reason, /immutable after the first write/);
  });

  it('always_after_first_write: allows first write', () => {
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/pivot-points.md',
      cwd: tmp,
      state: {},
      cfg: {},
      registry,
    });
    assert.equal(v.action, 'allow');
  });

  it('phase_lifecycle.phase_id_completed: blocks writes to completed phase artifacts', () => {
    const state = {
      execution: {
        phase_details: [
          { id: 'phase-2', status: 'completed' },
          { id: 'phase-3', status: 'in_progress' },
        ],
      },
    };
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/mpl/phases/phase-2/changes.diff',
      cwd: tmp,
      state,
      cfg: {},
      registry,
    });
    assert.equal(v.action, 'block');
    assert.equal(v.code, 'completed_phase_artifact_mutation');
    assert.match(v.reason, /phase-2/);
  });

  it('phase_lifecycle.phase_id_completed: allows writes to incomplete phase artifacts', () => {
    const state = {
      execution: {
        phase_details: [
          { id: 'phase-2', status: 'completed' },
          { id: 'phase-3', status: 'in_progress' },
        ],
      },
    };
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/mpl/phases/phase-3/changes.diff',
      cwd: tmp,
      state,
      cfg: {},
      registry,
    });
    assert.equal(v.action, 'allow');
  });

  it('phase_lifecycle (contract_phase_id): blocks contract writes for completed phases', () => {
    const state = {
      execution: {
        phase_details: [{ id: 'phase-4', status: 'completed' }],
      },
    };
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/contracts/phase-4.json',
      cwd: tmp,
      state,
      cfg: {},
      registry,
    });
    assert.equal(v.action, 'block');
    assert.match(v.reason, /phase-4/);
  });

  it('phase_lifecycle: honors completed_phase_immutability_required=false opt-out', () => {
    const state = {
      execution: {
        phase_details: [{ id: 'phase-2', status: 'completed' }],
      },
    };
    const cfg = { completed_phase_immutability_required: false };
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/mpl/phases/phase-2/changes.diff',
      cwd: tmp,
      state,
      cfg,
      registry,
    });
    assert.equal(v.action, 'allow');
  });

  it('completed_phase_block_unchanged: partial edit on decomposition.yaml is blocked when phases are completed', () => {
    const state = {
      execution: { phase_details: [{ id: 'phase-1', status: 'completed' }] },
    };
    const registry = loadChannelRegistry({});
    const v = evaluateImmutability({
      relPath: '.mpl/mpl/decomposition.yaml',
      oldText: '- id: phase-1\n',
      newText: '',
      state,
      cwd: tmp,
      cfg: {},
      toolName: 'Edit',
      registry,
    });
    assert.equal(v.action, 'block');
    assert.match(v.reason, /partial_edit_not_allowed/);
  });
});

// ===========================================================================
// evaluateChannelWrite — composite top-level
// ===========================================================================

describe('evaluateChannelWrite', () => {
  it('forbidden pattern is the first-priority block', () => {
    const v = evaluateChannelWrite({
      cwd: tmp,
      state: {},
      cfg: {},
      relPath: '.mpl/scratchpad.md',
      newText: 'whatever',
      toolName: 'Write',
      hookEvent: 'PreToolUse',
    });
    assert.equal(v.action, 'block');
    assert.equal(v.code, 'forbidden_channel');
  });

  it('unregistered .mpl/ path is blocked', () => {
    const v = evaluateChannelWrite({
      cwd: tmp,
      state: {},
      cfg: {},
      relPath: '.mpl/random-new-file.md',
      newText: 'x',
      toolName: 'Write',
      hookEvent: 'PreToolUse',
    });
    assert.equal(v.action, 'block');
    assert.equal(v.code, 'unregistered_channel');
  });

  it('allowed path passes through', () => {
    const v = evaluateChannelWrite({
      cwd: tmp,
      state: {},
      cfg: {},
      relPath: '.mpl/state.json',
      newText: '{}',
      toolName: 'Write',
      hookEvent: 'PreToolUse',
    });
    assert.equal(v.action, 'allow');
    assert.equal(v.classification.kind, 'allowed');
  });

  it('outside_mpl is always allowed', () => {
    const v = evaluateChannelWrite({
      cwd: tmp,
      state: {},
      cfg: {},
      relPath: 'src/app.ts',
      newText: 'x',
      toolName: 'Write',
      hookEvent: 'PreToolUse',
    });
    assert.equal(v.action, 'allow');
    assert.equal(v.classification.kind, 'outside_mpl');
  });

  it('focus.categories=[baseline] only activates baseline rules', () => {
    // Forbidden file should still be allowed because focus disables forbidden.
    const v = evaluateChannelWrite({
      cwd: tmp,
      state: {},
      cfg: {},
      relPath: '.mpl/scratchpad.md',
      newText: 'x',
      toolName: 'Write',
      hookEvent: 'PreToolUse',
      focus: {
        runForbidden: false,
        runAllowlist: false,
        runSchema: false,
        categories: ['baseline'],
      },
    });
    assert.equal(v.action, 'allow');
  });

  it('focus narrowed to baseline blocks rewrites of existing baseline.yaml', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), 'old\n');
    const v = evaluateChannelWrite({
      cwd: tmp,
      state: {},
      cfg: {},
      relPath: '.mpl/mpl/baseline.yaml',
      newText: 'new\n',
      toolName: 'Write',
      hookEvent: 'PreToolUse',
      focus: {
        runForbidden: false,
        runAllowlist: false,
        runSchema: false,
        rules: ['baseline_renewal_sentinel_absent'],
      },
    });
    assert.equal(v.action, 'block');
    assert.equal(v.code, 'baseline_immutable');
  });

  it('retryContext aggregates rule_match + when + captures', () => {
    const state = {
      execution: {
        phase_details: [{ id: 'phase-2', status: 'completed' }],
      },
    };
    const v = evaluateChannelWrite({
      cwd: tmp,
      state,
      cfg: {},
      relPath: '.mpl/mpl/phases/phase-2/changes.diff',
      newText: 'x',
      toolName: 'Write',
      hookEvent: 'PreToolUse',
      focus: {
        runForbidden: false,
        runAllowlist: false,
        runSchema: false,
        rules: ['phase_lifecycle.phase_id_completed'],
      },
    });
    assert.equal(v.action, 'block');
    assert.ok(v.retryContext);
    assert.equal(v.retryContext.when, 'phase_lifecycle.phase_id_completed');
    // raw capture is the suffix (`2`); the evaluator prefixes to
    // `phase-2` for state lookup and exposes the prefixed id in
    // retryContext.phase_id.
    assert.equal(v.retryContext.captures?.phase_id, '2');
    assert.equal(v.retryContext.phase_id, 'phase-2');
  });

  it('PostToolUse: schema-bound channel triggers schema check', () => {
    const v = evaluateChannelWrite({
      cwd: tmp,
      state: {},
      cfg: {},
      relPath: '.mpl/pivot-points.md',
      newText: '## Random heading only\n',
      toolName: 'Write',
      hookEvent: 'PostToolUse',
    });
    assert.equal(v.action, 'block');
    assert.equal(v.code, 'missing_artifact_schema');
    assert.match(v.reason, /PP_id/);
  });

  it('PreToolUse: schema validation is skipped (only PostToolUse runs schema)', () => {
    const v = evaluateChannelWrite({
      cwd: tmp,
      state: {},
      cfg: {},
      relPath: '.mpl/pivot-points.md',
      newText: '## Random\n',
      toolName: 'Write',
      hookEvent: 'PreToolUse',
    });
    // Pre-tool: allowed channel + no existing file → allow (since
    // always_after_first_write evaluator says first write is OK).
    assert.equal(v.action, 'allow');
  });
});

// ===========================================================================
// Integration: existing hook shims still produce expected outputs.
// ===========================================================================

describe('shim integration: mpl-baseline-guard', () => {
  it('denies a baseline rewrite without renewal sentinel', () => {
    const dir = freshWorkspace();
    try {
      writeFileSync(join(dir, '.mpl', 'mpl', 'baseline.yaml'), 'old\n');
      const r = JSON.parse(execFileSync(
        'node',
        [join(HOOKS_DIR, 'mpl-baseline-guard.mjs')],
        {
          input: JSON.stringify({
            cwd: dir,
            tool_name: 'Write',
            tool_input: { file_path: '.mpl/mpl/baseline.yaml', content: 'new\n' },
          }),
          encoding: 'utf-8',
        },
      ));
      assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny');
      assert.match(r.hookSpecificOutput?.permissionDecisionReason || '', /Baseline Guard/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows the first baseline write', () => {
    const dir = freshWorkspace();
    try {
      const r = JSON.parse(execFileSync(
        'node',
        [join(HOOKS_DIR, 'mpl-baseline-guard.mjs')],
        {
          input: JSON.stringify({
            cwd: dir,
            tool_name: 'Write',
            tool_input: { file_path: '.mpl/mpl/baseline.yaml', content: 'fresh\n' },
          }),
          encoding: 'utf-8',
        },
      ));
      assert.equal(r.continue, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shim integration: mpl-artifact-schema CLI mode (channel-registry SSOT)', () => {
  it('CLI mode walks schema-bound channels and reports per-file verdicts', () => {
    const dir = freshWorkspace();
    try {
      mkdirSync(join(dir, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
      mkdirSync(join(dir, '.mpl', 'mpl', 'phases', 'phase-2'), { recursive: true });
      const valid = '## Status\n## Files Changed\n## Verification\n## Decisions\n## Next Phase Context\n';
      writeFileSync(join(dir, '.mpl', 'mpl', 'phases', 'phase-1', 'state-summary.md'), valid);
      writeFileSync(join(dir, '.mpl', 'mpl', 'phases', 'phase-2', 'state-summary.md'), '## bad\n');
      writeFileSync(join(dir, '.mpl', 'pivot-points.md'),
        '## PP_id\n## constraint\n## status\n## source\n');
      let exit = 0;
      let stdout = '';
      try {
        stdout = execFileSync('node', [join(HOOKS_DIR, 'mpl-artifact-schema.mjs'), dir], {
          encoding: 'utf-8',
        });
      } catch (e) {
        exit = e.status ?? -1;
        stdout = e.stdout?.toString?.() ?? '';
      }
      assert.equal(exit, 1);
      const r = JSON.parse(stdout);
      assert.equal(r.totals.files, 3);
      assert.equal(r.totals.invalid, 1);
      const bad = r.results.find((x) => x.file.endsWith('phase-2/state-summary.md'));
      assert.equal(bad.valid, false);
      assert.ok(bad.missing.includes('files_changed'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
