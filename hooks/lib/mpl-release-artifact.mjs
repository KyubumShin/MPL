/**
 * Stage A Phase 1.6c-iii release-artifact helpers.
 *
 * Three responsibilities (RFC §5.4.1):
 *
 *   1. **Snapshot ref** — create `refs/mpl/releases/{cut_id}` pointing at
 *      HEAD's commit so the cut's state is pinned independently of any
 *      subsequent working-branch commits. Capture `commit_sha` /
 *      `tree_sha` for the manifest.
 *
 *   2. **User-visible artifacts** (`tag` / `branch` / `draft_pr`) — best-
 *      effort post-step that operates against the snapshot ref, not the
 *      current working branch. Failures surface as
 *      `artifact_creation_failed` in the manifest but do NOT block the
 *      cohort from being marked released (RFC §5.4: "Tying immutability
 *      to artifact delivery would create stuck states where the user
 *      cannot recover").
 *
 *   3. **No-op for `release_manifest`** — that artifact type means
 *      manifest + snapshot ref only, no external push/PR.
 *
 * Every git/gh invocation is wrapped in try/catch. The library NEVER
 * throws — every helper returns a structured `{ok: true, ...}` or
 * `{ok: false, reason: string}`. The phase-controller decides how to
 * surface the result (manifest write or stopReason).
 *
 * Working-tree safety: snapshot ref creation does not modify the index
 * or working tree; tag/branch creation are pure ref writes; only the
 * push step talks to a remote. If push fails the local ref survives so
 * the user can retry manually.
 */

import { execFileSync } from 'child_process';

/**
 * Capture HEAD's commit_sha + tree_sha and create the snapshot ref
 * `refs/mpl/releases/{cutId}` pointing at the commit. Returns the three
 * identifiers on success, or a structured failure on any git error.
 *
 * `git update-ref` is idempotent — re-running with the same target is a
 * no-op. Pointing to a new commit overwrites the prior ref, which is
 * fine because release-finalize re-entry should re-pin the snapshot to
 * the latest cohort tip.
 *
 * **HEAD-drift caveat (PR #188 claude review #4)**: the caller is
 * responsible for ensuring HEAD is at the cohort's terminal commit when
 * this helper is invoked. Stage A's release-gate → release-finalize is
 * a tight loop in the normal flow, but if the user makes unrelated
 * commits between release-gate PASS and release-finalize firing the
 * snapshot pins those instead of the cohort tip. Stage B will likely
 * need an explicit "release-finalize must run on the cohort tip"
 * invariant; until then this is a contract on the caller.
 *
 * **Push (PR #188 claude review #3)**: after local ref creation succeeds,
 * the helper best-effort pushes `snapshot_ref` to `origin` so downstream
 * consumers (CI, mpl-status, fresh clones) can verify the manifest's
 * `commit_sha` against the canonical remote pin. Push failure is
 * non-fatal — the local ref remains the canonical record. The result
 * object's `pushed` boolean + `push_reason` (set when push fails)
 * surface this to the caller; lifecycle decisions do NOT depend on
 * push success.
 *
 * @param {string} cwd
 * @param {string} cutId
 * @returns {{ok: true, commit_sha: string, tree_sha: string, snapshot_ref: string, pushed: boolean, push_reason: string|null} | {ok: false, reason: string}}
 */
export function createSnapshotRef(cwd, cutId) {
  if (typeof cutId !== 'string' || !cutId) {
    return { ok: false, reason: 'cutId must be a non-empty string' };
  }
  const snapshot_ref = `refs/mpl/releases/${cutId}`;
  try {
    const commit_sha = git(cwd, ['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{40}$/.test(commit_sha)) {
      return { ok: false, reason: `git rev-parse HEAD returned unexpected output: ${commit_sha.slice(0, 80)}` };
    }
    const tree_sha = git(cwd, ['rev-parse', 'HEAD^{tree}']).trim();
    if (!/^[0-9a-f]{40}$/.test(tree_sha)) {
      return { ok: false, reason: `git rev-parse HEAD^{tree} returned unexpected output: ${tree_sha.slice(0, 80)}` };
    }
    git(cwd, ['update-ref', snapshot_ref, commit_sha]);
    const pushResult = tryPushRef(cwd, snapshot_ref);
    return {
      ok: true,
      commit_sha,
      tree_sha,
      snapshot_ref,
      pushed: pushResult.pushed,
      push_reason: pushResult.ok ? null : pushResult.reason,
    };
  } catch (err) {
    return { ok: false, reason: stringifyError(err) };
  }
}

/**
 * Look up the commit a ref currently points at, or `null` if absent /
 * unreadable. Used by tag/branch creators to make the operation
 * idempotent (PR #188 claude review #1): if the ref already exists at
 * the requested commit, treat as no-op rather than failing with "tag
 * already exists".
 */
function refExists(cwd, ref) {
  try {
    const sha = git(cwd, ['rev-parse', '--verify', ref]).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Create + push a `tag` artifact (`refs/tags/mpl-release-{cutId}`).
 *
 * Local tag is created first via `git tag <name> <commit>` (force overwrite
 * not used — re-running on an existing tag is an error, surfaced as reason).
 * Push is attempted only when an `origin` remote is configured; missing
 * remote is treated as a soft-failure (`reason` set, `ok: false`) so the
 * user knows the tag exists locally but was not published.
 *
 * @returns {{ok: true, tag: string, pushed: boolean} | {ok: false, reason: string, tag?: string}}
 */
export function createArtifactTag(cwd, cutId, commitSha) {
  if (typeof cutId !== 'string' || !cutId) return { ok: false, reason: 'cutId must be a non-empty string' };
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(commitSha)) {
    return { ok: false, reason: 'commitSha must be a 40-char hex string' };
  }
  const tag = `mpl-release-${cutId}`;
  const tagRef = `refs/tags/${tag}`;
  // Idempotent re-creation (PR #188 claude review #1): if the tag already
  // exists at the same commit, treat the local step as a no-op and still
  // attempt push (a push of an already-pushed ref is also a no-op). If it
  // exists at a DIFFERENT commit, refuse — overwriting a shipped tag
  // would silently change an external claim (the whole point of §5.4.1
  // immutability).
  const existing = refExists(cwd, tagRef);
  if (existing === commitSha) {
    const pushResult = tryPushRef(cwd, tagRef);
    if (!pushResult.ok) {
      return { ok: false, reason: `tag exists locally at same commit but push failed: ${pushResult.reason}`, tag, noop: true };
    }
    return { ok: true, tag, pushed: pushResult.pushed, noop: true };
  }
  if (existing && existing !== commitSha) {
    return {
      ok: false,
      reason: `tag ${tag} already exists at different commit ${existing.slice(0, 12)} — refusing to overwrite a shipped release tag. Delete the stale tag (git tag -d ${tag}) and retry if intentional.`,
      tag,
    };
  }
  try {
    git(cwd, ['tag', tag, commitSha]);
  } catch (err) {
    return { ok: false, reason: `git tag failed: ${stringifyError(err)}`, tag };
  }
  const pushResult = tryPushRef(cwd, tagRef);
  if (!pushResult.ok) {
    return { ok: false, reason: `tag created locally but push failed: ${pushResult.reason}`, tag };
  }
  return { ok: true, tag, pushed: pushResult.pushed };
}

/**
 * Create + push a `branch` artifact (`mpl/release/{cutId}`).
 *
 * The branch points at the snapshot commit, NOT at HEAD-at-release-time
 * (those may diverge if release-finalize re-runs after later commits).
 *
 * @returns {{ok: true, branch: string, pushed: boolean} | {ok: false, reason: string, branch?: string}}
 */
export function createArtifactBranch(cwd, cutId, commitSha) {
  if (typeof cutId !== 'string' || !cutId) return { ok: false, reason: 'cutId must be a non-empty string' };
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(commitSha)) {
    return { ok: false, reason: 'commitSha must be a 40-char hex string' };
  }
  const branch = `mpl/release/${cutId}`;
  const branchRef = `refs/heads/${branch}`;
  // Same idempotency semantics as createArtifactTag (PR #188 claude #1):
  // existing-at-same-sha = noop, existing-at-different-sha = refuse.
  const existing = refExists(cwd, branchRef);
  if (existing === commitSha) {
    const pushResult = tryPushRef(cwd, branchRef);
    if (!pushResult.ok) {
      return { ok: false, reason: `branch exists locally at same commit but push failed: ${pushResult.reason}`, branch, noop: true };
    }
    return { ok: true, branch, pushed: pushResult.pushed, noop: true };
  }
  if (existing && existing !== commitSha) {
    return {
      ok: false,
      reason: `branch ${branch} already exists at different commit ${existing.slice(0, 12)} — refusing to overwrite. Delete the stale branch (git branch -D ${branch}) and retry if intentional.`,
      branch,
    };
  }
  try {
    git(cwd, ['branch', branch, commitSha]);
  } catch (err) {
    return { ok: false, reason: `git branch failed: ${stringifyError(err)}`, branch };
  }
  const pushResult = tryPushRef(cwd, branchRef);
  if (!pushResult.ok) {
    return { ok: false, reason: `branch created locally but push failed: ${pushResult.reason}`, branch };
  }
  return { ok: true, branch, pushed: pushResult.pushed };
}

/**
 * Create a draft PR via `gh pr create --draft`. Requires the release
 * branch to already exist on the remote. The PR body links the snapshot
 * ref and includes the canonical "do not push to this branch" warning
 * from RFC §5.4.1.
 *
 * Soft-failures: missing `gh` CLI, missing repo remote, gh auth failure.
 * All return `{ok: false, reason}` — never throws.
 *
 * @returns {{ok: true, pr_url: string, branch: string} | {ok: false, reason: string, branch?: string}}
 */
export function createArtifactDraftPr(cwd, cutId, branchName, snapshotRef) {
  if (typeof cutId !== 'string' || !cutId) return { ok: false, reason: 'cutId must be a non-empty string' };
  if (typeof branchName !== 'string' || !branchName) return { ok: false, reason: 'branchName must be a non-empty string' };
  const body =
    `MPL Stage A release artifact for cut \`${cutId}\`.\n\n` +
    `**Snapshot ref:** \`${snapshotRef || 'refs/mpl/releases/' + cutId}\`\n\n` +
    `⚠ Do not push to this branch. Further work happens on the working branch; ` +
    `subsequent cohort commits do NOT update this PR. This PR is frozen at the snapshot point.`;
  try {
    const out = execFileSync('gh', [
      'pr', 'create',
      '--draft',
      '--head', branchName,
      '--title', `MPL release: ${cutId}`,
      '--body', body,
    ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    const url = out.trim().split('\n').find((l) => /^https?:\/\//.test(l));
    return { ok: true, pr_url: url || out.trim(), branch: branchName };
  } catch (err) {
    return { ok: false, reason: `gh pr create failed: ${stringifyError(err)}`, branch: branchName };
  }
}

/**
 * Dispatch by artifact type.
 *
 * Returns the per-type result plus a normalized `artifact_creation_failed`
 * field shaped for the release-manifest:
 *   - successful  → `null` (no failure to report)
 *   - skipped     → `null` (e.g., `release_manifest` artifact = no-op)
 *   - failed      → `{ type, reason }` for the manifest to record verbatim
 *
 * `release_manifest` and `null`/undefined artifact types are treated as
 * no-ops — the snapshot ref + manifest file are the artifact in those
 * cases.
 *
 * @param {{cwd: string, cutId: string, artifact: string|null, commitSha: string, snapshotRef: string}} opts
 * @returns {{result: object|null, artifact_creation_failed: {type: string, reason: string}|null}}
 */
export function attemptArtifactCreation(opts) {
  const { cwd, cutId, artifact, commitSha, snapshotRef } = opts;
  if (!artifact || artifact === 'release_manifest') {
    return { result: null, artifact_creation_failed: null };
  }
  if (artifact === 'tag') {
    const r = createArtifactTag(cwd, cutId, commitSha);
    return {
      result: r,
      artifact_creation_failed: r.ok ? null : { type: 'tag', reason: r.reason },
    };
  }
  if (artifact === 'branch') {
    const r = createArtifactBranch(cwd, cutId, commitSha);
    return {
      result: r,
      artifact_creation_failed: r.ok ? null : { type: 'branch', reason: r.reason },
    };
  }
  if (artifact === 'draft_pr') {
    // draft_pr requires the release branch on remote. Create+push the
    // branch first, then open the PR against it. If the branch step
    // fails, surface that — the PR cannot succeed without it.
    const branchResult = createArtifactBranch(cwd, cutId, commitSha);
    if (!branchResult.ok) {
      return {
        result: branchResult,
        artifact_creation_failed: { type: 'draft_pr', reason: `branch prerequisite failed: ${branchResult.reason}` },
      };
    }
    // Idempotency (PR #188 claude #1): when the branch step is a noop
    // (release-finalize re-entry on the same commit), assume the PR
    // from the prior run is still open and skip `gh pr create`. Re-
    // running `gh pr create` against an existing PR would fail with
    // "a pull request already exists" — that's a spurious surface, not
    // a real artifact failure.
    if (branchResult.noop) {
      return {
        result: { ok: true, branch: branchResult.branch, noop: true, pr_skipped: 'branch noop — assumed PR from prior run still open' },
        artifact_creation_failed: null,
      };
    }
    const prResult = createArtifactDraftPr(cwd, cutId, branchResult.branch, snapshotRef);
    return {
      result: prResult,
      artifact_creation_failed: prResult.ok ? null : { type: 'draft_pr', reason: prResult.reason },
    };
  }
  return {
    result: null,
    artifact_creation_failed: { type: artifact, reason: `unsupported artifact type: ${artifact}` },
  };
}

// ────────────────────────── internals ──────────────────────────

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function hasOriginRemote(cwd) {
  try {
    const out = git(cwd, ['remote']);
    return out.split('\n').map((s) => s.trim()).includes('origin');
  } catch {
    return false;
  }
}

function tryPushRef(cwd, ref) {
  // No `origin` configured → treat as soft "skipped" failure so the caller
  // surfaces that the artifact exists locally but was not published. This
  // is common in CI/test environments and explicitly tolerated by RFC §5.4
  // ("artifact creation depends on external tools out of MPL's control").
  if (!hasOriginRemote(cwd)) {
    return { ok: false, pushed: false, reason: 'no `origin` remote configured' };
  }
  try {
    git(cwd, ['push', 'origin', ref]);
    return { ok: true, pushed: true };
  } catch (err) {
    return { ok: false, pushed: false, reason: stringifyError(err) };
  }
}

function stringifyError(err) {
  if (!err) return 'unknown error';
  // execFileSync errors carry stderr in the `stderr` buffer; surface that
  // rather than the generic message when present so the manifest's
  // `artifact_creation_failed.reason` is actionable.
  const stderr = err.stderr && (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf-8'));
  if (stderr && stderr.trim()) {
    return stderr.trim().split('\n').slice(0, 3).join(' | ').slice(0, 400);
  }
  return String(err.message || err).slice(0, 400);
}
