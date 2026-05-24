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

  // PR #188 claude review #3: snapshot ref push surface.
  it('surfaces pushed:false + push_reason when no `origin` remote is configured', () => {
    initGitRepo(tmpDir);
    const r = createSnapshotRef(tmpDir, 'mvp');
    assert.equal(r.ok, true);
    assert.equal(r.pushed, false);
    assert.match(r.push_reason, /no .?origin.? remote configured/);
  });

  it('surfaces pushed:true when origin (bare remote) is configured', () => {
    initGitRepo(tmpDir);
    // Wire a bare remote so the push succeeds.
    const remoteDir = mkdtempSync(join(tmpdir(), 'mpl-art-bare-'));
    try {
      git(remoteDir, ['init', '--bare']);
      git(tmpDir, ['remote', 'add', 'origin', remoteDir]);
      const r = createSnapshotRef(tmpDir, 'mvp');
      assert.equal(r.ok, true);
      assert.equal(r.pushed, true);
      assert.equal(r.push_reason, null);
      // Remote actually carries the ref.
      const remoteSha = git(remoteDir, ['rev-parse', 'refs/mpl/releases/mvp']).trim();
      assert.equal(remoteSha, r.commit_sha);
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
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

  // PR #188 claude review #1: idempotent re-creation.
  it('idempotent re-run with same commit reports noop:true (no spurious "tag already exists")', () => {
    initGitRepo(tmpDir);
    const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    const first = createArtifactTag(tmpDir, 'mvp', sha);
    // First run still soft-fails on push (no remote) — that's expected.
    assert.equal(first.ok, false);
    assert.equal(first.tag, 'mpl-release-mvp');
    // Second run: existing-at-same-sha → noop:true (no git tag invocation).
    const second = createArtifactTag(tmpDir, 'mvp', sha);
    assert.equal(second.noop, true);
    assert.equal(second.tag, 'mpl-release-mvp');
    assert.doesNotMatch(second.reason || '', /already exists/i,
      'must NOT surface "tag already exists" — that was the pre-fix spurious failure');
  });

  it('refuses to overwrite an existing tag pointing at a different commit (release immutability)', () => {
    initGitRepo(tmpDir);
    const originalSha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    createArtifactTag(tmpDir, 'mvp', originalSha);  // creates local tag
    // Make a new commit so the next snapshot would point at a different SHA.
    writeFileSync(join(tmpDir, 'second.md'), '# second\n');
    git(tmpDir, ['add', 'second.md']);
    git(tmpDir, ['commit', '-m', 'second']);
    const newSha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(newSha, originalSha);
    const r = createArtifactTag(tmpDir, 'mvp', newSha);
    assert.equal(r.ok, false);
    assert.match(r.reason, /already exists at different commit/);
    assert.match(r.reason, /refusing to overwrite/);
  });

  it('idempotent re-run succeeds (ok:true, noop:true) when origin remote is set up', () => {
    initGitRepo(tmpDir);
    const remoteDir = mkdtempSync(join(tmpdir(), 'mpl-art-bare-tag-'));
    try {
      git(remoteDir, ['init', '--bare']);
      git(tmpDir, ['remote', 'add', 'origin', remoteDir]);
      const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
      const first = createArtifactTag(tmpDir, 'mvp', sha);
      assert.equal(first.ok, true);
      assert.equal(first.pushed, true);
      const second = createArtifactTag(tmpDir, 'mvp', sha);
      assert.equal(second.ok, true);
      assert.equal(second.noop, true);
      assert.equal(second.pushed, true);
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
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

  // PR #188 claude review #1: idempotent re-creation, symmetric with tag.
  it('idempotent re-run with same commit reports noop:true', () => {
    initGitRepo(tmpDir);
    const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    createArtifactBranch(tmpDir, 'mvp', sha);
    const second = createArtifactBranch(tmpDir, 'mvp', sha);
    assert.equal(second.noop, true);
    assert.equal(second.branch, 'mpl/release/mvp');
    assert.doesNotMatch(second.reason || '', /already exists/i);
  });

  it('refuses to overwrite an existing branch pointing at a different commit', () => {
    initGitRepo(tmpDir);
    const originalSha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    createArtifactBranch(tmpDir, 'mvp', originalSha);
    writeFileSync(join(tmpDir, 'second.md'), '# second\n');
    git(tmpDir, ['add', 'second.md']);
    git(tmpDir, ['commit', '-m', 'second']);
    const newSha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    const r = createArtifactBranch(tmpDir, 'mvp', newSha);
    assert.equal(r.ok, false);
    assert.match(r.reason, /already exists at different commit/);
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

  // PR #188 claude review #1: draft_pr idempotency on re-run skips `gh pr create`
  // so it cannot fail with "a pull request already exists".
  it('draft_pr re-run with branch noop skips gh pr create (no spurious "already exists")', () => {
    initGitRepo(tmpDir);
    const remoteDir = mkdtempSync(join(tmpdir(), 'mpl-art-bare-pr-'));
    try {
      git(remoteDir, ['init', '--bare']);
      git(tmpDir, ['remote', 'add', 'origin', remoteDir]);
      const sha = git(tmpDir, ['rev-parse', 'HEAD']).trim();
      // First attempt: create the branch via the helper. (Skip the actual
      // PR creation by short-circuiting — we just need the local branch
      // present so the second run's branch step is a noop.)
      createArtifactBranch(tmpDir, 'mvp', sha);
      // Second attempt via attemptArtifactCreation. Branch step is noop;
      // attemptArtifactCreation should skip the gh pr create call.
      const second = attemptArtifactCreation({
        cwd: tmpDir, cutId: 'mvp', artifact: 'draft_pr',
        commitSha: sha, snapshotRef: 'refs/mpl/releases/mvp',
      });
      assert.equal(second.artifact_creation_failed, null,
        're-run with noop branch must not surface a draft_pr failure');
      assert.equal(second.result.noop, true);
      assert.match(second.result.pr_skipped, /branch noop/);
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
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
