#!/usr/bin/env node
/**
 * P2b — isolation CLI wire.
 *
 * Surfaces the worktree-pool API from `policy/isolation.mjs` plus the
 * git-fed drift check `detectImpactDriftFromGit` (lives in `scheduler.mjs`
 * to avoid `isolation → scheduler` reverse import — wired here at the
 * CLI boundary).
 *
 * Protocol (uniform across MPL CLIs):
 *   stdin:  single JSON object — required `cwd` for repo-bound subcommands.
 *   stdout: single-line JSON envelope `{ ok: boolean, ... }`.
 *   stderr: human-readable trace lines only — parsers IGNORE stderr.
 *   exit:   0 success, 1 classified failure, 2 infra error,
 *           64 malformed stdin.
 *
 * Subcommands:
 *   assert-clean       — assertCleanWorkingTree (catches throw → ok:false)
 *   acquire-slot       — acquireSlot (returns acquired_base_sha for drift)
 *   release-slot       — releaseSlot
 *   freeze-contracts   — freezeContractsForWave
 *   refresh-heartbeat  — refreshHeartbeat
 *   is-slot-stale      — isSlotStale
 *   detect-drift       — detectImpactDriftFromGit (from scheduler.mjs)
 *   resolve-pool-root  — resolvePoolRoot (env-var passthrough)
 *
 * Environment passthrough: MPL_WORKTREE_POOL_ROOT flows through process.env
 * naturally so resolvePoolRoot resolves identically under sudo / agent
 * contexts.
 */

import { readSync } from 'fs';

import {
  assertCleanWorkingTree,
  acquireSlot,
  releaseSlot,
  freezeContractsForWave,
  refreshHeartbeat,
  isSlotStale,
  resolvePoolRoot,
} from './isolation.mjs';
import { detectImpactDriftFromGit } from './scheduler.mjs';

function readStdinSync() {
  const chunks = [];
  const BUF_SIZE = 65536;
  const buf = Buffer.alloc(BUF_SIZE);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let bytes = 0;
    try {
      bytes = readSync(0, buf, 0, BUF_SIZE, null);
    } catch (err) {
      if (err && err.code === 'EAGAIN') continue;
      if (err && err.code === 'EOF') break;
      throw err;
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function fail(error_name, error_message, error_payload, exit_code = 1) {
  emit({ ok: false, error_name, error_message, error_payload: error_payload || null });
  process.exit(exit_code);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function subAssertClean(input) {
  const { cwd } = input || {};
  if (typeof cwd !== 'string' || !cwd) return fail('InvalidInput', 'cwd required', null, 64);
  try {
    assertCleanWorkingTree(cwd);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function subAcquireSlot(input) {
  const { cwd, phase_id, slot_id, run_id, base_ref, pool_root, freeze_paths } = input || {};
  const r = acquireSlot({
    cwd,
    phase_id,
    slot_id,
    run_id,
    base_ref: base_ref || 'HEAD',
    pool_root: pool_root || null,
    freeze_paths: Array.isArray(freeze_paths) ? freeze_paths : null,
  });
  // Already structured `{ ok, ... }` per isolation.mjs contract.
  return r;
}

function subReleaseSlot(input) {
  const { cwd, worktree_root, branch, force, delete_branch } = input || {};
  const r = releaseSlot({
    cwd,
    worktree_root,
    branch: branch || null,
    force: !!force,
    delete_branch: !!delete_branch,
  });
  return r;
}

function subFreezeContracts(input) {
  const { cwd, slot_path, freeze_paths } = input || {};
  if (typeof cwd !== 'string' || !cwd) return fail('InvalidInput', 'cwd required', null, 64);
  if (typeof slot_path !== 'string' || !slot_path) {
    return fail('InvalidInput', 'slot_path required', null, 64);
  }
  return freezeContractsForWave({
    cwd,
    slot_path,
    freeze_paths: Array.isArray(freeze_paths) ? freeze_paths : null,
  });
}

function subRefreshHeartbeat(input) {
  const { worktree_root } = input || {};
  return refreshHeartbeat(worktree_root);
}

function subIsSlotStale(input) {
  const { worktree_root, staleness_ms } = input || {};
  const r = isSlotStale(worktree_root, { staleness_ms: Number.isFinite(staleness_ms) ? staleness_ms : undefined });
  return { ok: true, stale: r.stale, age_ms: r.age_ms };
}

function subDetectDrift(input) {
  const { worktree_root, base_ref, declared } = input || {};
  const r = detectImpactDriftFromGit(worktree_root, base_ref, declared || {});
  return r;
}

function subResolvePoolRoot(input) {
  const { run_id, pool_root } = input || {};
  const root = resolvePoolRoot({ run_id, pool_root: pool_root || null });
  return { ok: true, pool_root: root };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const subcommand = process.argv[2];
  if (!subcommand) {
    fail('MissingSubcommand', 'usage: isolation-cli <subcommand> < input.json', null, 64);
    return;
  }

  let raw;
  try {
    raw = readStdinSync();
  } catch (err) {
    fail('StdinReadError', `stdin read failed: ${err?.message || err}`, null, 64);
    return;
  }

  let input = {};
  if (raw.trim().length > 0) {
    try {
      input = JSON.parse(raw);
    } catch (err) {
      fail('MalformedStdin', `invalid JSON on stdin: ${err?.message || err}`, null, 64);
      return;
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('MalformedStdin', 'stdin must be a JSON object', null, 64);
    return;
  }

  let result;
  try {
    switch (subcommand) {
      case 'assert-clean':       result = subAssertClean(input); break;
      case 'acquire-slot':       result = subAcquireSlot(input); break;
      case 'release-slot':       result = subReleaseSlot(input); break;
      case 'freeze-contracts':   result = subFreezeContracts(input); break;
      case 'refresh-heartbeat':  result = subRefreshHeartbeat(input); break;
      case 'is-slot-stale':      result = subIsSlotStale(input); break;
      case 'detect-drift':       result = subDetectDrift(input); break;
      case 'resolve-pool-root':  result = subResolvePoolRoot(input); break;
      default:
        fail('UnknownSubcommand', `unrecognized subcommand: ${subcommand}`, { subcommand }, 64);
        return;
    }
  } catch (err) {
    fail('UncaughtError', err?.message || String(err), { stack: err?.stack || null }, 2);
    return;
  }

  if (!result) return; // sub-* already emitted+exited via fail()
  emit(result);
  process.exit(result.ok ? 0 : 1);
}

import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}

export {
  subAssertClean,
  subAcquireSlot,
  subReleaseSlot,
  subFreezeContracts,
  subRefreshHeartbeat,
  subIsSlotStale,
  subDetectDrift,
  subResolvePoolRoot,
};
