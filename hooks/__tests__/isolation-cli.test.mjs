/**
 * P2b — hooks/lib/policy/isolation-cli.mjs.
 *
 * Pure-helper coverage (in-process) + black-box stdin/stdout for the
 * representative subcommands. The git-integration suite spins up a real
 * temp repo so the acquire / detect-drift round trip is exercised
 * end-to-end (mock-free per scout #5).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  subAssertClean,
  subResolvePoolRoot,
  subDetectDrift,
  subIsSlotStale,
  subRefreshHeartbeat,
} from '../lib/policy/isolation-cli.mjs';

const CLI_PATH = fileURLToPath(new URL('../lib/policy/isolation-cli.mjs', import.meta.url));

function runCli(subcommand, input) {
  return spawnSync('node', [CLI_PATH, subcommand], {
    input: JSON.stringify(input || {}),
    encoding: 'utf-8',
  });
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}
function gitAvailable() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  return r.status === 0;
}
function makeRepo(tmp) {
  git(['init', '-b', 'main'], tmp);
  git(['config', 'user.email', 'mpl-test@example.com'], tmp);
  git(['config', 'user.name', 'mpl-test'], tmp);
  git(['config', 'commit.gpgsign', 'false'], tmp);
  writeFileSync(join(tmp, 'README.md'), 'x\n');
  git(['add', '.'], tmp);
  git(['commit', '-m', 'init'], tmp);
}

// ---------------------------------------------------------------------------
// pure subcommands
// ---------------------------------------------------------------------------

describe('isolation-cli — resolve-pool-root', () => {
  it('returns the caller-supplied pool_root when safe', () => {
    const r = subResolvePoolRoot({ run_id: 'r1', pool_root: '/tmp/custom-pool' });
    assert.equal(r.ok, true);
    assert.equal(r.pool_root, '/tmp/custom-pool');
  });
  it('falls back to tmpdir when pool_root is unsafe', () => {
    const r = subResolvePoolRoot({ run_id: 'r1', pool_root: '/etc/bad' });
    assert.equal(r.ok, true);
    assert.match(r.pool_root, /mpl-wt-r1$/);
  });
});

describe('isolation-cli — is-slot-stale + refresh-heartbeat', () => {
  let slot;
  beforeEach(() => { slot = mkdtempSync(join(tmpdir(), 'mpl-iso-cli-hb-')); mkdirSync(join(slot, '.mpl'), { recursive: true }); });
  afterEach(() => { rmSync(slot, { recursive: true, force: true }); });

  it('fresh heartbeat is not stale', () => {
    subRefreshHeartbeat({ worktree_root: slot });
    const r = subIsSlotStale({ worktree_root: slot, staleness_ms: 60_000 });
    assert.equal(r.ok, true);
    assert.equal(r.stale, false);
  });
  it('negative staleness window forces stale', () => {
    subRefreshHeartbeat({ worktree_root: slot });
    const r = subIsSlotStale({ worktree_root: slot, staleness_ms: -1 });
    assert.equal(r.stale, true);
  });
});

describe('isolation-cli — detect-drift validation', () => {
  it('non-absolute worktree_root → ok:false', () => {
    const r = subDetectDrift({ worktree_root: 'relative', base_ref: 'HEAD', declared: {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /absolute/);
  });
  it('empty base_ref → ok:false', () => {
    const r = subDetectDrift({ worktree_root: '/tmp/x', base_ref: '', declared: {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /base_ref/);
  });
});

// ---------------------------------------------------------------------------
// black-box stdin/stdout
// ---------------------------------------------------------------------------

describe('isolation-cli — black-box stdin/stdout', () => {
  it('resolve-pool-root invokable via Bash', () => {
    const r = runCli('resolve-pool-root', { run_id: 'r1', pool_root: '/tmp/custom-pool' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.pool_root, '/tmp/custom-pool');
  });

  it('malformed stdin → exit 64', () => {
    const r = spawnSync('node', [CLI_PATH, 'resolve-pool-root'], { input: 'not-json', encoding: 'utf-8' });
    assert.equal(r.status, 64);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error_name, 'MalformedStdin');
  });

  it('unknown subcommand → exit 64', () => {
    const r = runCli('not-a-subcommand', {});
    assert.equal(r.status, 64);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error_name, 'UnknownSubcommand');
  });
});

// ---------------------------------------------------------------------------
// git-integration suite
// ---------------------------------------------------------------------------

const integration = gitAvailable() ? describe : describe.skip;

integration('isolation-cli — git integration', () => {
  let workspace;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'mpl-iso-cli-git-'));
    makeRepo(workspace);
  });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

  it('assert-clean returns ok:true on a clean repo', () => {
    const r = subAssertClean({ cwd: workspace });
    assert.equal(r.ok, true);
    assert.equal(r.error, null);
  });

  it('assert-clean returns ok:false on a dirty repo (no throw)', () => {
    writeFileSync(join(workspace, 'dirty.txt'), 'x');
    const r = subAssertClean({ cwd: workspace });
    assert.equal(r.ok, false);
    assert.match(r.error, /uncommitted/);
  });

  it('detect-drift round trip: git diff observed paths feed pure detectImpactDrift', () => {
    // Set up: capture HEAD SHA, add a new commit, then run detect-drift
    // against the captured base.
    const baseSha = git(['rev-parse', 'HEAD'], workspace).stdout.trim();
    writeFileSync(join(workspace, 'observed-undeclared.ts'), 'export const x = 1;\n');
    writeFileSync(join(workspace, 'observed-declared.ts'), 'export const y = 2;\n');
    git(['add', '.'], workspace);
    git(['commit', '-m', 'add observed files'], workspace);

    const r = subDetectDrift({
      worktree_root: workspace,
      base_ref: baseSha,
      declared: { create: ['observed-declared.ts'], modify: [], affected_tests: [] },
    });
    assert.equal(r.ok, true, r.error || '');
    assert.deepEqual(r.observed.sort(), ['observed-declared.ts', 'observed-undeclared.ts']);
    assert.equal(r.drift, true);
    assert.deepEqual(r.undeclared, ['observed-undeclared.ts']);
    assert.deepEqual(r.missing_declared, []);
  });

  it('detect-drift returns ok:false when base_ref does not resolve', () => {
    const r = subDetectDrift({
      worktree_root: workspace,
      base_ref: 'nonexistent-sha-deadbeef',
      declared: {},
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /git diff failed/);
  });
});
