import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  createSnapshotRef,
  createArtifactTag,
  createArtifactBranch,
  createArtifactDraftPr,
  attemptArtifactCreation,
} from '../lib/mpl-release-artifact.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function initGitRepo(dir) {
  git(dir, ['init', '--initial-branch=main']);
  // Local identity so commits work without global config in CI.
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  // Disable GPG signing so tests do not depend on the developer's local
  // commit.gpgsign / tag.gpgSign / user.signingkey settings (#176 pattern).
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'tag.gpgSign', 'false']);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'initial']);
}

describe('createSnapshotRef', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-art-snap-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('captures commit_sha + tree_sha and creates refs/mpl/releases/{cutId}', () => {
    initGitRepo(tmpDir);
    const r = createSnapshotRef(tmpDir, 'mvp');
    assert.equal(r.ok, true);
    assert.match(r.commit_sha, /^[0-9a-f]{40}$/);
    assert.match(r.tree_sha, /^[0-9a-f]{40}$/);
    assert.equal(r.snapshot_ref, 'refs/mpl/releases/mvp');
    // Verify the ref actually exists in the repo.
    const refTarget = git(tmpDir, ['rev-parse', r.snapshot_ref]).trim();
    assert.equal(refTarget, r.commit_sha);
  });

  it('is idempotent — re-running on the same HEAD overwrites the ref to the same commit', () => {
    initGitRepo(tmpDir);
    const first = createSnapshotRef(tmpDir, 'mvp');
    const second = createSnapshotRef(tmpDir, 'mvp');
    assert.equal(second.ok, true);
    assert.equal(second.commit_sha, first.commit_sha);
  });

  it('re-points the ref when HEAD advances (release-finalize re-entry after new cohort commits)', () => {
    initGitRepo(tmpDir);
    const first = createSnapshotRef(tmpDir, 'mvp');
    writeFileSync(join(tmpDir, 'extra.md'), '# extra\n');
    git(tmpDir, ['add', 'extra.md']);
    git(tmpDir, ['commit', '-m', 'second']);
    const second = createSnapshotRef(tmpDir, 'mvp');
    assert.equal(second.ok, true);
    assert.notEqual(second.commit_sha, first.commit_sha);
    assert.equal(git(tmpDir, ['rev-parse', second.snapshot_ref]).trim(), second.commit_sha);
  });

  it('returns ok:false with a reason when cwd is not a git repo', () => {
    // Fresh tmpDir without git init — every git call will fail.
    const r = createSnapshotRef(tmpDir, 'mvp');
    assert.equal(r.ok, false);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  });

  it('returns ok:false when cutId is empty / non-string', () => {
    initGitRepo(tmpDir);
    assert.equal(createSnapshotRef(tmpDir, '').ok, false);
    assert.equal(createSnapshotRef(tmpDir, null).ok, false);
    assert.equal(createSnapshotRef(tmpDir, undefined).ok, false);
  });
});

describe('createArtifactTag', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-art-tag-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates the local tag but reports ok:false when no origin remote (soft-fail)', () => {
    initGitRepo(tmpDir);
    const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    const r = createArtifactTag(tmpDir, 'mvp', sha);
    // RFC §5.4: tag creation depends on external tools (remote permissions);
    // soft-fail when no remote so the user knows the tag exists locally.
    assert.equal(r.ok, false);
    assert.match(r.reason, /push failed.*no .?origin.? remote configured/);
    assert.equal(r.tag, 'mpl-release-mvp');
    // Local tag exists.
    const localRef = git(tmpDir, ['rev-parse', 'refs/tags/mpl-release-mvp']).trim();
    assert.equal(localRef, sha);
  });

  it('rejects malformed commitSha', () => {
    initGitRepo(tmpDir);
    assert.equal(createArtifactTag(tmpDir, 'mvp', 'not-a-sha').ok, false);
    assert.equal(createArtifactTag(tmpDir, 'mvp', '').ok, false);
  });
});

describe('createArtifactBranch', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-art-branch-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates the local branch but reports ok:false when no origin remote (soft-fail)', () => {
    initGitRepo(tmpDir);
    const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    const r = createArtifactBranch(tmpDir, 'mvp', sha);
    assert.equal(r.ok, false);
    assert.match(r.reason, /push failed/);
    assert.equal(r.branch, 'mpl/release/mvp');
    // Local branch exists at the snapshot commit.
    const localRef = git(tmpDir, ['rev-parse', 'refs/heads/mpl/release/mvp']).trim();
    assert.equal(localRef, sha);
  });
});

describe('attemptArtifactCreation dispatch', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-art-dispatch-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns no-op result for release_manifest artifact (snapshot+manifest only)', () => {
    initGitRepo(tmpDir);
    const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    const r = attemptArtifactCreation({
      cwd: tmpDir, cutId: 'mvp',
      artifact: 'release_manifest',
      commitSha: sha, snapshotRef: 'refs/mpl/releases/mvp',
    });
    assert.equal(r.result, null);
    assert.equal(r.artifact_creation_failed, null);
  });

  it('returns no-op for null/undefined artifact', () => {
    const r = attemptArtifactCreation({
      cwd: tmpDir, cutId: 'mvp', artifact: null,
      commitSha: '0'.repeat(40), snapshotRef: 'refs/mpl/releases/mvp',
    });
    assert.equal(r.artifact_creation_failed, null);
  });

  it('records artifact_creation_failed when tag push has no remote (soft-fail surfaced to manifest)', () => {
    initGitRepo(tmpDir);
    const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    const r = attemptArtifactCreation({
      cwd: tmpDir, cutId: 'mvp',
      artifact: 'tag',
      commitSha: sha, snapshotRef: 'refs/mpl/releases/mvp',
    });
    assert.equal(r.artifact_creation_failed.type, 'tag');
    assert.match(r.artifact_creation_failed.reason, /push failed/);
  });

  it('records artifact_creation_failed when branch push has no remote', () => {
    initGitRepo(tmpDir);
    const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    const r = attemptArtifactCreation({
      cwd: tmpDir, cutId: 'mvp',
      artifact: 'branch',
      commitSha: sha, snapshotRef: 'refs/mpl/releases/mvp',
    });
    assert.equal(r.artifact_creation_failed.type, 'branch');
  });

  it('records artifact_creation_failed when draft_pr branch prerequisite fails', () => {
    initGitRepo(tmpDir);
    const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    const r = attemptArtifactCreation({
      cwd: tmpDir, cutId: 'mvp',
      artifact: 'draft_pr',
      commitSha: sha, snapshotRef: 'refs/mpl/releases/mvp',
    });
    // No remote → branch push fails → draft_pr surface mentions the
    // branch prerequisite so the user knows the chain entry point.
    assert.equal(r.artifact_creation_failed.type, 'draft_pr');
    assert.match(r.artifact_creation_failed.reason, /branch prerequisite failed/);
  });

  it('rejects unsupported artifact type', () => {
    const r = attemptArtifactCreation({
      cwd: tmpDir, cutId: 'mvp',
      artifact: 'rocket',
      commitSha: '0'.repeat(40), snapshotRef: 'refs/mpl/releases/mvp',
    });
    assert.equal(r.artifact_creation_failed.type, 'rocket');
    assert.match(r.artifact_creation_failed.reason, /unsupported artifact type/);
  });
});

describe('createArtifactDraftPr soft-fail when gh CLI is unavailable', () => {
  let tmpDir;
  let pathBackup;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-art-pr-'));
    pathBackup = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = pathBackup;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok:false with reason when `gh` is not on PATH (no throw)', () => {
    // Override PATH to a single empty dir so gh cannot be found.
    const isolated = mkdtempSync(join(tmpdir(), 'mpl-art-pr-path-'));
    try {
      process.env.PATH = isolated;
      const r = createArtifactDraftPr(tmpDir, 'mvp', 'mpl/release/mvp', 'refs/mpl/releases/mvp');
      assert.equal(r.ok, false);
      assert.match(r.reason, /gh pr create failed/);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('uses an injected `gh` stub on PATH and surfaces the PR URL on success', () => {
    // Inject a `gh` shim that prints a canned URL and exits 0.
    const stubDir = mkdtempSync(join(tmpdir(), 'mpl-art-pr-stub-'));
    try {
      const ghPath = join(stubDir, 'gh');
      writeFileSync(ghPath, '#!/bin/sh\necho "https://github.com/example/repo/pull/42"\n');
      chmodSync(ghPath, 0o755);
      process.env.PATH = `${stubDir}:${pathBackup}`;
      const r = createArtifactDraftPr(tmpDir, 'mvp', 'mpl/release/mvp', 'refs/mpl/releases/mvp');
      assert.equal(r.ok, true);
      assert.equal(r.pr_url, 'https://github.com/example/repo/pull/42');
      assert.equal(r.branch, 'mpl/release/mvp');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
