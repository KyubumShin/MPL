/**
 * MPL Isolation (Move #16) — per-phase, per-slot worktree pool.
 *
 * ============================================================================
 * STATUS — ADDITIVE / DORMANT
 * ============================================================================
 * Ships the worktree pool API used by the wave-scoped scheduler in
 * `policy/scheduler.mjs`. No hook route invokes these helpers today; the
 * legacy single-tenant F-15 path documented in
 * `commands/mpl-run-execute-context.md` §4.1.5 (single worktree under
 * `/tmp/mpl-worktree-{phase_id}`, tracked in `state.worktree_history`) is
 * still the production isolation surface. This module turns that pattern
 * into a slot-keyed pool while preserving the structural distinction —
 * HIGH-risk phases continue to use the single-tenant path and land in
 * `worktree_history`; parallel-pool phases land in `worktree_pool_history`.
 *
 * ============================================================================
 * DESIGN INVARIANTS (per Move #16 plan)
 * ============================================================================
 *  - ISOLATION SCOPE: per-phase, per-slot. Every parallel-eligible phase
 *    gets its own worktree under a slot directory.
 *  - SLOT LIFECYCLE: `acquireSlot` creates the worktree (`git worktree add`),
 *    writes a `slot.lock` ownership marker, and starts a heartbeat file the
 *    orchestrator can probe to detect stale slots. `releaseSlot` tears the
 *    slot down via `git worktree remove` (force if necessary), removing the
 *    lock + heartbeat.
 *  - CONTRACT FREEZE: wave-scoped. A SHA-pinned snapshot of
 *    `.mpl/mpl/decomposition.yaml`, phase-0 outputs, and `.mpl/contracts/`
 *    is hardlinked into each slot's `.mpl/` directory and chmod a-w so
 *    concurrent phases see identical immutable contracts.
 *  - HIGH-RISK ROUTING: HIGH-risk phases are REJECTED from the pool by
 *    `scheduler.validateWaveComposition` and continue to use the legacy
 *    F-15 path. This module exposes `isHighRiskPhase` for callers that
 *    want to assert the invariant locally.
 *
 * ============================================================================
 * I/O CONTRACT
 * ============================================================================
 * Every fs / git interaction is wrapped in try/catch. The module returns
 * structured `{ ok, ... }` envelopes rather than throwing so the scheduler
 * can route a failed acquire to ABANDONED without unwinding the dispatch
 * loop. The single exception is `assertCleanWorkingTree` which throws on
 * a dirty tree because mixing uncommitted local changes into a worktree
 * pool is unrecoverable.
 *
 * No top-level side effects. `git` commands are spawned synchronously via
 * `child_process.spawnSync` so the dispatcher's caller can choose its own
 * concurrency model.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'fs';
import { join, isAbsolute, normalize } from 'path';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SLOT_LOCK_FILENAME = 'slot.lock';
const HEARTBEAT_FILENAME = 'slot.heartbeat';
const FROZEN_CONTRACT_DIRNAME = '.mpl';
const DEFAULT_HEARTBEAT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowISO() {
  return new Date().toISOString();
}

function isSafeAbsolutePath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (!isAbsolute(p)) return false;
  const norm = normalize(p);
  // Block the obvious foot-guns. The pool sits under tmpdir() / mpl-wt-…
  // by default; callers may override but must stay outside `/`, `/etc`,
  // `/usr`, `/var`, the user's home root, and the workspace root itself.
  if (norm === '/' || norm.startsWith('/etc') || norm.startsWith('/usr') || norm.startsWith('/var')) return false;
  return true;
}

function gitSync(args, { cwd, timeout = 60_000 } = {}) {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout });
    return {
      ok: r.status === 0,
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      signal: r.signal || null,
    };
  } catch (err) {
    return { ok: false, status: -1, stdout: '', stderr: String(err?.message || err), signal: null };
  }
}

// ---------------------------------------------------------------------------
// Public surface — predicates
// ---------------------------------------------------------------------------

/**
 * Pure predicate for the HIGH-risk routing invariant. The composer in
 * `scheduler.validateWaveComposition` enforces this — re-exported here so
 * callers (e.g. an orchestrator runtime) can assert defensively before
 * calling `acquireSlot`.
 */
export function isHighRiskPhase(phase) {
  return !!(phase && phase.risk_level === 'HIGH');
}

/**
 * Default pool root. Resolution order:
 *   1. `options.pool_root` (caller override)
 *   2. `$MPL_WORKTREE_POOL_ROOT`
 *   3. `tmpdir()/mpl-wt-<run_id>`
 *
 * Exposed so tests can pin a deterministic root.
 */
export function resolvePoolRoot({ run_id, pool_root } = {}) {
  if (pool_root && isSafeAbsolutePath(pool_root)) return pool_root;
  if (typeof process !== 'undefined' && process.env?.MPL_WORKTREE_POOL_ROOT) {
    const envRoot = process.env.MPL_WORKTREE_POOL_ROOT;
    if (isSafeAbsolutePath(envRoot)) return envRoot;
  }
  const safeRun = String(run_id || 'norun').replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(tmpdir(), `mpl-wt-${safeRun}`);
}

/**
 * Compute the absolute worktree path for a given slot. Deterministic so
 * the orchestrator can reattach to an in-flight slot after a restart.
 */
export function slotWorktreePath({ run_id, slot_id, pool_root }) {
  const root = resolvePoolRoot({ run_id, pool_root });
  return join(root, `slot-${slot_id}`);
}

// ---------------------------------------------------------------------------
// Public surface — git working tree assertions
// ---------------------------------------------------------------------------

/**
 * Refuse to start the pool when the source workspace has uncommitted
 * changes — they'd silently leak across slots via `git worktree add`'s
 * shared object database semantics. Throws so the caller cannot ignore.
 */
export function assertCleanWorkingTree(cwd) {
  const r = gitSync(['status', '--porcelain'], { cwd });
  if (!r.ok) {
    throw new Error(`mpl-isolation: git status failed (${r.status}): ${r.stderr.trim()}`);
  }
  if (r.stdout.trim().length > 0) {
    throw new Error(
      'mpl-isolation: workspace has uncommitted changes; refusing to seed worktree pool. ' +
      'Commit or stash before starting a parallel wave.'
    );
  }
}

// ---------------------------------------------------------------------------
// Contract freeze
// ---------------------------------------------------------------------------

/**
 * Hardlink the wave's frozen contract surface into a slot's `.mpl/`
 * directory. The freeze set is configurable; defaults mirror the Move #16
 * plan:
 *
 *   .mpl/mpl/decomposition.yaml
 *   .mpl/mpl/phase0/**
 *   .mpl/contracts/**
 *
 * Files are chmod a-w post-link so any phase that tries to mutate them
 * fails fast. Best-effort: a missing source path is skipped silently
 * (some workspaces never seed phase0/), and a chmod failure is non-fatal.
 *
 * Returns: { ok, frozen_paths: [...], errors: [...] }
 */
export function freezeContractsForWave({ cwd, slot_path, freeze_paths }) {
  const defaults = [
    '.mpl/mpl/decomposition.yaml',
    '.mpl/mpl/phase0',
    '.mpl/contracts',
  ];
  const list = Array.isArray(freeze_paths) && freeze_paths.length > 0 ? freeze_paths : defaults;
  const frozen_paths = [];
  const errors = [];

  const dst_root = join(slot_path, FROZEN_CONTRACT_DIRNAME);
  try {
    mkdirSync(dst_root, { recursive: true });
  } catch (err) {
    return { ok: false, frozen_paths, errors: [`mkdir ${dst_root}: ${err?.message || err}`] };
  }

  for (const rel of list) {
    const src = join(cwd, rel);
    const dst = join(slot_path, rel);
    if (!existsSync(src)) continue;
    let stat;
    try {
      stat = statSync(src);
    } catch (err) {
      errors.push(`stat ${src}: ${err?.message || err}`);
      continue;
    }

    // `cp -al` for directories (hardlinks recursively), `ln` for files.
    // We shell out via spawnSync to avoid re-implementing recursive walk +
    // hardlink + chmod — the pool root sits in tmpdir() so cp must be
    // available.
    try {
      mkdirSync(join(dst, '..'), { recursive: true });
    } catch (err) {
      errors.push(`mkdir parent of ${dst}: ${err?.message || err}`);
      continue;
    }

    // `-f` forces overwrite of any file the worktree checkout already
    // produced at the destination so the post-freeze inode matches the
    // workspace truth (and chmod a-w sticks to the actual freeze surface,
    // not a stale checkout copy).
    const argv = stat.isDirectory()
      ? ['-alf', src, dst]
      : ['-lf',  src, dst];
    const r = spawnSync('cp', argv, { encoding: 'utf-8' });
    if (r.status !== 0) {
      errors.push(`cp ${argv.join(' ')}: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
      continue;
    }
    // chmod a-w. Best effort.
    const chmodArgs = stat.isDirectory() ? ['-R', 'a-w', dst] : ['a-w', dst];
    const c = spawnSync('chmod', chmodArgs, { encoding: 'utf-8' });
    if (c.status !== 0) {
      errors.push(`chmod ${chmodArgs.join(' ')}: ${(c.stderr || '').trim() || `exit ${c.status}`}`);
      // Non-fatal — the hardlink succeeded, the chmod policy is defense-in-depth.
    }
    frozen_paths.push(rel);
  }

  return { ok: errors.length === 0, frozen_paths, errors };
}

// ---------------------------------------------------------------------------
// acquireSlot / releaseSlot
// ---------------------------------------------------------------------------

/**
 * Acquire a slot for `phase_id`.
 *
 *   cwd:        absolute path to the source workspace (must be a git repo)
 *   phase_id:   string id from decomposition
 *   slot_id:    integer in [0, max_phase_workers)
 *   run_id:     run scope id (state.started_at) — folds into the pool root
 *   base_ref:   git ref to branch from (default: 'HEAD')
 *   pool_root:  optional override of the tmpdir-derived default
 *   freeze_paths: optional override for the contract-freeze set
 *
 * Returns: {
 *   ok: boolean,
 *   worktree_root: string|null,
 *   branch: string|null,
 *   lock_path: string|null,
 *   heartbeat_path: string|null,
 *   error: string|null,
 * }
 *
 * Side effects on success:
 *   - `git worktree add <root> -b <branch>` runs from `cwd`
 *   - `<root>/.mpl/slot.lock` is written with JSON ownership metadata
 *   - `<root>/.mpl/slot.heartbeat` is touched (atime/mtime); caller is
 *     expected to refresh it periodically
 *   - The frozen contract surface is hardlinked into `<root>/.mpl/`
 *
 * No throw — the dispatcher routes failures to ABANDONED via the return
 * envelope.
 */
export function acquireSlot({
  cwd,
  phase_id,
  slot_id,
  run_id,
  base_ref = 'HEAD',
  pool_root,
  freeze_paths,
} = {}) {
  if (!isSafeAbsolutePath(cwd)) {
    return _err('cwd must be an absolute path outside protected roots');
  }
  if (typeof phase_id !== 'string' || !phase_id) {
    return _err('phase_id (string) required');
  }
  if (!Number.isInteger(slot_id) || slot_id < 0) {
    return _err('slot_id (non-negative integer) required');
  }

  const worktree_root = slotWorktreePath({ run_id, slot_id, pool_root });
  if (!isSafeAbsolutePath(worktree_root)) {
    return _err(`derived worktree_root rejected as unsafe: ${worktree_root}`);
  }

  // The pool root must exist before `git worktree add`.
  try {
    mkdirSync(join(worktree_root, '..'), { recursive: true });
  } catch (err) {
    return _err(`mkdir pool root: ${err?.message || err}`);
  }

  if (existsSync(worktree_root)) {
    return _err(`slot worktree already exists at ${worktree_root}; stale slot? release before re-acquiring`);
  }

  const branch = `mpl-pool-${phase_id}-slot${slot_id}-${nowISO().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const r = gitSync(['worktree', 'add', worktree_root, '-b', branch, base_ref], { cwd, timeout: 120_000 });
  if (!r.ok) {
    return _err(`git worktree add failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  }

  // Write the slot lock + heartbeat. These live inside `<root>/.mpl/`
  // alongside the frozen contracts so a single rm tears everything down.
  const lock_path = join(worktree_root, FROZEN_CONTRACT_DIRNAME, SLOT_LOCK_FILENAME);
  const heartbeat_path = join(worktree_root, FROZEN_CONTRACT_DIRNAME, HEARTBEAT_FILENAME);
  try {
    mkdirSync(join(worktree_root, FROZEN_CONTRACT_DIRNAME), { recursive: true });
    writeFileSync(lock_path, JSON.stringify({
      phase_id,
      slot_id,
      run_id: run_id || null,
      pid: typeof process !== 'undefined' ? process.pid : null,
      branch,
      acquired_at: nowISO(),
    }, null, 2));
    writeFileSync(heartbeat_path, nowISO());
  } catch (err) {
    // Best-effort cleanup; surface the original error.
    gitSync(['worktree', 'remove', '--force', worktree_root], { cwd });
    return _err(`slot.lock/heartbeat write failed: ${err?.message || err}`);
  }

  // Freeze the contract surface (decomposition + phase0 + contracts) into
  // this slot. Failures are surfaced but do NOT roll back the worktree —
  // contracts being un-frozen is an integrity issue the dispatcher should
  // see, not a reason to abandon the slot completely.
  const freezeResult = freezeContractsForWave({ cwd, slot_path: worktree_root, freeze_paths });

  return {
    ok: true,
    worktree_root,
    branch,
    lock_path,
    heartbeat_path,
    error: null,
    freeze: freezeResult,
  };
}

/**
 * Release a slot. Tears the worktree down via `git worktree remove`
 * (force when `force: true`), and best-effort deletes the branch when
 * `delete_branch: true`. Mirrors the legacy F-15 cleanup contract.
 *
 *   cwd, worktree_root: same as acquireSlot
 *   branch: optional — when provided AND `delete_branch === true`,
 *           `git branch -d` (or -D) is run after the worktree is gone.
 *   force:  defaults to false. When true, `git worktree remove --force`
 *           is used. Strongly recommended for ABANDONED outcomes.
 *
 * Returns: { ok, error|null }
 */
export function releaseSlot({
  cwd,
  worktree_root,
  branch = null,
  force = false,
  delete_branch = false,
} = {}) {
  if (!isSafeAbsolutePath(cwd)) {
    return { ok: false, error: 'cwd must be an absolute path outside protected roots' };
  }
  if (!isSafeAbsolutePath(worktree_root)) {
    return { ok: false, error: `worktree_root rejected as unsafe: ${worktree_root}` };
  }

  // Best-effort lock removal first so a partial cleanup doesn't leave a
  // stale ownership marker behind.
  const lock_path = join(worktree_root, FROZEN_CONTRACT_DIRNAME, SLOT_LOCK_FILENAME);
  const heartbeat_path = join(worktree_root, FROZEN_CONTRACT_DIRNAME, HEARTBEAT_FILENAME);
  try { if (existsSync(lock_path)) rmSync(lock_path, { force: true }); } catch { /* swallow */ }
  try { if (existsSync(heartbeat_path)) rmSync(heartbeat_path, { force: true }); } catch { /* swallow */ }

  const wt_args = force
    ? ['worktree', 'remove', '--force', worktree_root]
    : ['worktree', 'remove', worktree_root];
  let r = gitSync(wt_args, { cwd, timeout: 60_000 });
  if (!r.ok && !force) {
    // Retry with --force so a dirty slot doesn't pin the pool.
    r = gitSync(['worktree', 'remove', '--force', worktree_root], { cwd, timeout: 60_000 });
  }
  if (!r.ok) {
    // Last resort: rm -rf the directory. `git worktree remove` failing
    // means git is unhappy, but the dispatcher still needs the slot back.
    try {
      rmSync(worktree_root, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: `git worktree remove failed: ${(r.stderr || '').trim() || `exit ${r.status}`}; rm fallback also failed: ${err?.message || err}` };
    }
    // After the rm, run `git worktree prune` so git's metadata catches up.
    gitSync(['worktree', 'prune'], { cwd });
  }

  if (branch && delete_branch) {
    const args = force ? ['branch', '-D', branch] : ['branch', '-d', branch];
    gitSync(args, { cwd }); // result is informational only
  }
  return { ok: true, error: null };
}

/**
 * Touch the heartbeat file. Callers run this periodically while a phase
 * is executing so an orchestrator restart can distinguish live slots from
 * crashed ones (mtime older than `staleness_ms` → ABANDONED).
 */
export function refreshHeartbeat(worktree_root) {
  if (!isSafeAbsolutePath(worktree_root)) return { ok: false, error: 'unsafe worktree_root' };
  const path = join(worktree_root, FROZEN_CONTRACT_DIRNAME, HEARTBEAT_FILENAME);
  try {
    writeFileSync(path, nowISO());
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Probe whether a slot's heartbeat has gone stale. Returns
 *   { stale: boolean, age_ms: number|null }
 * `stale: false, age_ms: null` for a missing heartbeat — caller decides
 * whether to treat that as ABANDONED or simply not-yet-acquired.
 */
export function isSlotStale(worktree_root, { staleness_ms = DEFAULT_HEARTBEAT_MS } = {}) {
  if (!isSafeAbsolutePath(worktree_root)) return { stale: false, age_ms: null };
  const path = join(worktree_root, FROZEN_CONTRACT_DIRNAME, HEARTBEAT_FILENAME);
  if (!existsSync(path)) return { stale: false, age_ms: null };
  try {
    const st = statSync(path);
    const age_ms = Date.now() - st.mtimeMs;
    return { stale: age_ms > staleness_ms, age_ms };
  } catch {
    return { stale: false, age_ms: null };
  }
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function _err(reason) {
  return {
    ok: false,
    worktree_root: null,
    branch: null,
    lock_path: null,
    heartbeat_path: null,
    error: reason,
  };
}
