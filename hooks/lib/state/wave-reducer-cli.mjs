#!/usr/bin/env node
/**
 * P2b — wave-reducer CLI wire.
 *
 * Thin wrapper around `mergeWaveShards` so the orchestrator can collapse
 * a wave's shards through one Bash invocation. Single subcommand `merge`
 * is the only producer the orchestrator needs at wave end — helper
 * subcommands (apply-rfc6902, merge-policy-for, sha256-of-state) live
 * on the producer side via `shard-writer.mjs` and are out of scope here.
 *
 * Protocol (uniform across MPL CLIs):
 *   stdin:  { cwd, wave_id, config? }
 *   stdout (ok):
 *     {
 *       ok: true,
 *       applied_shards: [phase_id...],
 *       isolated_shards: [{phase_id, violation}...],
 *       downgrade_to_sequential: boolean,
 *       request_meta?: {wave_id, phase_id, request},
 *       merged_summary: {phase_lifecycle_count, completed_count}
 *     }
 *   stdout (classified failure):
 *     {
 *       ok: false,
 *       failure_code: 'stale_shard_base' | 'unknown_field_ownership' |
 *                     'merge_error' | 'wave_reducer_unresolvable' |
 *                     'merge_error:textual_conflict',
 *       error_name, error_payload
 *     }
 *   exit codes: 0 on ok:true, 1 on classified failure, 2 on
 *               unrecognized throw, 64 on malformed stdin.
 *
 * `merged_summary` is intentionally a count-only summary — Bash output
 * capture has a size ceiling and the orchestrator can re-read state.json
 * via `mpl_state_read`. The full merged state never needs to round-trip
 * through stdout.
 */

import { readSync } from 'fs';

import {
  mergeWaveShards,
  StaleShardBaseError,
  UnknownFieldOwnershipError,
  ShardPatchTestFailedError,
  WaveReducerInvariantUnresolvableError,
} from './wave-reducer.mjs';

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

function failEnvelope(error_name, error_message, error_payload, exit_code) {
  emit({ ok: false, error_name, error_message, error_payload: error_payload || null });
  process.exit(exit_code);
}

/**
 * Map a wave-reducer throw to its canonical failure_code (per
 * mpl-scheduler-failure-codes.mjs). Returned shape is the classified
 * failure envelope the orchestrator's catch block expects.
 */
function classifyAndEmit(err) {
  if (err instanceof StaleShardBaseError) {
    emit({
      ok: false,
      failure_code: 'stale_shard_base',
      error_name: 'StaleShardBaseError',
      error_message: err.message,
      error_payload: {
        expected_base_sha: err.expected_base_sha,
        actual_base_sha: err.actual_base_sha,
        drift_shards: err.drift_shards,
      },
    });
    process.exit(1);
  }
  if (err instanceof UnknownFieldOwnershipError) {
    emit({
      ok: false,
      failure_code: 'unknown_field_ownership',
      error_name: 'UnknownFieldOwnershipError',
      error_message: err.message,
      error_payload: { field: err.field, touching_shards: err.touching_shards },
    });
    process.exit(1);
  }
  if (err instanceof ShardPatchTestFailedError) {
    emit({
      ok: false,
      failure_code: 'merge_error:textual_conflict',
      error_name: 'ShardPatchTestFailedError',
      error_message: err.message,
      error_payload: { phase_id: err.phase_id, op_index: err.op_index, path: err.path },
    });
    process.exit(1);
  }
  if (err instanceof WaveReducerInvariantUnresolvableError) {
    emit({
      ok: false,
      failure_code: 'wave_reducer_unresolvable',
      error_name: 'WaveReducerInvariantUnresolvableError',
      error_message: err.message,
      error_payload: { wave_id: err.wave_id, isolated_shards: err.isolated_shards },
    });
    process.exit(1);
  }
  // Unrecognized — catch-all maps to merge_error so the orchestrator's
  // failure_code emission stays inside the allowlist. Exit 2 marks it
  // as an infra-class fallthrough so retry policy can distinguish.
  emit({
    ok: false,
    failure_code: 'merge_error',
    error_name: err?.name || 'Error',
    error_message: err?.message || String(err),
    error_payload: { stack: err?.stack || null },
  });
  process.exit(2);
}

async function main() {
  const subcommand = process.argv[2];
  if (subcommand !== 'merge') {
    failEnvelope('UnknownSubcommand', `expected 'merge', got '${subcommand}'`, { subcommand }, 64);
    return;
  }

  let raw;
  try {
    raw = readStdinSync();
  } catch (err) {
    failEnvelope('StdinReadError', `stdin read failed: ${err?.message || err}`, null, 64);
    return;
  }

  let input = {};
  if (raw.trim().length > 0) {
    try {
      input = JSON.parse(raw);
    } catch (err) {
      failEnvelope('MalformedStdin', `invalid JSON on stdin: ${err?.message || err}`, null, 64);
      return;
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    failEnvelope('MalformedStdin', 'stdin must be a JSON object', null, 64);
    return;
  }

  const { cwd, wave_id, config } = input;
  if (typeof cwd !== 'string' || !cwd) {
    failEnvelope('InvalidInput', 'cwd (absolute path) required', null, 64);
    return;
  }
  if (typeof wave_id !== 'string' || !wave_id) {
    failEnvelope('InvalidInput', 'wave_id required', null, 64);
    return;
  }

  let result;
  try {
    result = await mergeWaveShards(wave_id, cwd, { config: config || null });
  } catch (err) {
    classifyAndEmit(err);
    return;
  }

  // Build a small count-only summary so the orchestrator never needs to
  // round-trip the full state through stdout.
  const merged = result?.merged || {};
  const phase_lifecycle = merged?.phase_lifecycle || {};
  const lifecycle_count = Object.keys(phase_lifecycle).length;
  const completed_count = Object.values(phase_lifecycle).filter((v) => v?.status === 'COMPLETED').length;

  const envelope = {
    ok: true,
    applied_shards: result.applied_shards || [],
    isolated_shards: result.isolated_shards || [],
    downgrade_to_sequential: !!result.downgrade_to_sequential,
    merged_summary: {
      phase_lifecycle_count: lifecycle_count,
      completed_count,
    },
  };
  if (result.request_meta) envelope.request_meta = result.request_meta;
  emit(envelope);
  process.exit(0);
}

import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    classifyAndEmit(err);
  });
}

export { main, classifyAndEmit };
