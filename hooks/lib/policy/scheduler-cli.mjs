#!/usr/bin/env node
/**
 * P2b — scheduler CLI wire.
 *
 * Single-tick wrapper around the pure helpers in
 * `hooks/lib/policy/scheduler.mjs`. The orchestrator (or any parent Node
 * runtime) invokes this binary via Bash with one JSON object on stdin
 * and reads one JSON envelope on stdout. The CLI carries no callbacks —
 * `dispatch-tick` runs one tick with no-op callbacks and returns the
 * claimed ExecutionContexts so the orchestrator can spawn workers itself.
 *
 * Protocol (uniform across MPL CLIs):
 *   stdin:  single JSON object (heredoc-friendly so large waveState /
 *           decomposition payloads don't hit arg-length limits).
 *   stdout: single-line JSON envelope `{ ok: boolean, ... }`.
 *   stderr: human-readable trace lines only — parsers IGNORE stderr.
 *   exit:   0 success, 1 user/classified error, 2 infra error,
 *           64 malformed stdin.
 *   cwd:    required top-level `"cwd"` field on stdin (absolute path).
 *           CLI also accepts `--cwd` for shell ergonomics; stdin wins.
 *
 * Subcommands:
 *   plan-wave            — validateWaveComposition + buildWaveState composite
 *   validate-wave        — pure validateWaveComposition
 *   build-wave-state     — pure buildWaveState
 *   claim                — claim
 *   release              — release
 *   dispatch-tick        — dispatch_loop with no-op callbacks
 *   project-state-rows   — projectStateRows
 *   detect-impact-drift  — pure detectImpactDrift
 *   record-event         — append + ring-merge scheduler event (sanctioned
 *                          producer; closes the "told the LLM to log a line
 *                          but no Node code did" gap)
 *   classify-wave-failure — error_message → canonical failure_code via
 *                          mpl-scheduler-failure-codes.mjs allowlist
 */

import { readSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';

import {
  PHASE_LIFECYCLE_STATES,
  WAVE_REJECTION_CODES,
  validateWaveComposition,
  buildWaveState,
  claim,
  release,
  dispatch_loop,
  detectImpactDrift,
  projectStateRows,
} from './scheduler.mjs';
import { writeState } from '../state/writer.mjs';
import { readState } from '../state/reader.mjs';
import { FAILURE_CODE_ALLOWLIST } from '../mpl-scheduler-failure-codes.mjs';

// ---------------------------------------------------------------------------
// stdin/stdout plumbing
// ---------------------------------------------------------------------------

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

function parseArgvCwd(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') return argv[i + 1] || null;
    if (a.startsWith('--cwd=')) return a.slice('--cwd='.length);
  }
  return null;
}

function resolveCwd(input, argv) {
  if (input && typeof input.cwd === 'string' && input.cwd) return input.cwd;
  const fromArgv = parseArgvCwd(argv);
  return fromArgv;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function subPlanWave(input) {
  const {
    run_id, tier, wave_index, phase_ids, phases,
    completed_phase_ids, config,
  } = input || {};

  if (!Array.isArray(phase_ids) || !Array.isArray(phases)) {
    return fail('InvalidInput', 'phase_ids and phases must be arrays', { phase_ids, phases });
  }

  const wave = { tier, wave_index, phases };
  const validation = validateWaveComposition(wave, {
    completed_phase_ids: completed_phase_ids || [],
    reject_high_risk: true,
  });

  // Build the full state regardless so the caller can mirror the rejections
  // alongside the queue. The composer marks per-phase rejections; we then
  // filter the queue to only those that survived.
  const rejectedIds = new Set();
  const ready_but_blocked = [];
  for (const r of validation.reasons || []) {
    if (r && r.phase_id) {
      rejectedIds.add(r.phase_id);
      ready_but_blocked.push({ phase_id: r.phase_id, code: r.code, detail: r.detail });
    }
  }
  const queued_phase_ids = (phase_ids || []).filter((id) => !rejectedIds.has(id));

  const wave_state = buildWaveState({
    run_id,
    tier,
    wave_index,
    phase_ids: queued_phase_ids,
    config: config || {},
    tier_parallel: true,
  });

  return {
    ok: true,
    wave_state,
    rejection_reasons: validation.reasons || [],
    ready_but_blocked,
  };
}

function subValidateWave(input) {
  const { wave, completed_phase_ids, reject_high_risk } = input || {};
  if (!wave || !Array.isArray(wave.phases)) {
    return fail('InvalidInput', 'wave.phases array required', null);
  }
  const r = validateWaveComposition(wave, {
    completed_phase_ids: completed_phase_ids || [],
    reject_high_risk: reject_high_risk !== false,
  });
  return { ok: r.ok, reasons: r.reasons };
}

function subBuildWaveState(input) {
  const { run_id, tier, wave_index, phase_ids, config, tier_parallel } = input || {};
  const wave_state = buildWaveState({
    run_id,
    tier,
    wave_index,
    phase_ids: phase_ids || [],
    config: config || {},
    tier_parallel: tier_parallel !== false,
  });
  return { ok: true, wave_state };
}

function subClaim(input) {
  const { wave_state, phase_id, worktree_root } = input || {};
  if (!wave_state || typeof phase_id !== 'string') {
    return fail('InvalidInput', 'wave_state and phase_id required', null);
  }
  // claim() mutates wave_state in place. The caller passed it on stdin; we
  // round-trip it so the orchestrator sees the post-mutation shape.
  const execution_context = claim(wave_state, phase_id, { worktree_root: worktree_root || null });
  return { ok: !!execution_context, execution_context: execution_context || null, wave_state };
}

function subRelease(input) {
  const { wave_state, phase_id, outcome, reason } = input || {};
  if (!wave_state || typeof phase_id !== 'string') {
    return fail('InvalidInput', 'wave_state and phase_id required', null);
  }
  const released_context = release(wave_state, phase_id, {
    outcome: outcome || PHASE_LIFECYCLE_STATES.COMPLETED,
    reason: reason || null,
  });
  return { ok: !!released_context, released_context: released_context || null, wave_state };
}

function subDispatchTick(input) {
  const { wave_state, ready_phase_ids } = input || {};
  if (!wave_state) return fail('InvalidInput', 'wave_state required', null);

  // ready_phase_ids, when present, narrows the ready predicate. Otherwise
  // every queued phase is considered ready (composer pre-validated deps).
  const readyFilter = Array.isArray(ready_phase_ids) ? new Set(ready_phase_ids) : null;
  const dispatched = dispatch_loop(wave_state, {
    ready_predicate: (phase_id) => (readyFilter ? readyFilter.has(phase_id) : true),
    // No route_fn / acquire_slot — stdio cannot carry callbacks. The
    // orchestrator spawns workers itself with the returned contexts.
  });
  return { ok: true, dispatched, wave_state };
}

function subProjectStateRows(input) {
  const { wave_state, phase_lifecycle_carry, terminated_at } = input || {};
  if (!wave_state) return fail('InvalidInput', 'wave_state required', null);
  const projected = projectStateRows(wave_state, {
    phase_lifecycle_carry: phase_lifecycle_carry || {},
    terminated_at: terminated_at || null,
  });
  return {
    ok: true,
    running: projected.running,
    waves_in_flight: projected.waves_in_flight,
    phase_lifecycle: projected.phase_lifecycle,
  };
}

function subDetectImpactDrift(input) {
  const { declared, observed } = input || {};
  const r = detectImpactDrift(declared || {}, observed || []);
  return { ok: true, ...r };
}

function subRecordEvent(input, cwd) {
  const { event } = input || {};
  if (!event || typeof event !== 'object') {
    return fail('InvalidInput', 'event object required', null);
  }
  if (!cwd || typeof cwd !== 'string') {
    return fail('InvalidInput', 'cwd required (absolute path)', null);
  }

  // Default timestamp if caller omitted.
  const row = { ...event };
  if (!row.timestamp) row.timestamp = new Date().toISOString();

  // Append one line to .mpl/mpl/profile/phase-scheduler.jsonl.
  const jsonl_path = join(cwd, '.mpl', 'mpl', 'profile', 'phase-scheduler.jsonl');
  try {
    if (!existsSync(dirname(jsonl_path))) mkdirSync(dirname(jsonl_path), { recursive: true });
    appendFileSync(jsonl_path, JSON.stringify(row) + '\n');
  } catch (err) {
    return fail('AppendError', `jsonl append failed: ${err?.message || err}`, { jsonl_path }, 2);
  }

  // Mirror into state.phase_scheduler_history (ring cap 50, applied by writer).
  let history_length = 0;
  try {
    const current = readState(cwd) || {};
    const prior = Array.isArray(current.phase_scheduler_history) ? current.phase_scheduler_history : [];
    const next = prior.concat([row]);
    const merged = writeState(cwd, { phase_scheduler_history: next });
    history_length = Array.isArray(merged?.phase_scheduler_history) ? merged.phase_scheduler_history.length : next.length;
  } catch (err) {
    // The JSONL is the persistent source of truth; state mirror failure is
    // surfaced but not fatal so the producer can continue.
    return fail('StateMirrorError', `writeState mirror failed: ${err?.message || err}`, { jsonl_path }, 2);
  }

  return { ok: true, jsonl_path, history_length };
}

// Heuristic classifier — maps an error_message (and optional hint) to one
// of the allowlisted failure codes. Producer side: scheduler.mjs catch
// block hands the err.message in; this function picks the canonical code.
function subClassifyWaveFailure(input) {
  const { error_message, hint } = input || {};
  const msg = String(error_message || '').toLowerCase();
  const h = String(hint || '').toLowerCase();

  let code = 'unknown_runtime_error';

  // Allow caller to pass an explicit hint short-circuit.
  if (h && FAILURE_CODE_ALLOWLIST.has(h)) {
    code = h;
  } else if (/stale[_ ]shard|base[_ ]sha|drift/.test(msg)) {
    code = 'stale_shard_base';
  } else if (/unknown[_ ]field|field[_ ]ownership/.test(msg)) {
    code = 'unknown_field_ownership';
  } else if (/textual[_ ]conflict|patch[_ ]test/.test(msg)) {
    code = 'merge_error:textual_conflict';
  } else if (/wave[_ ]reducer|every shard violated|invariant.*unresolvable/.test(msg)) {
    code = 'wave_reducer_unresolvable';
  } else if (/merge[_ ]error|merge[_ ]failed|merge[_ ]worktree/.test(msg)) {
    code = 'merge_error';
  } else if (/worktree|pool|isolation|slot.*setup|git worktree add/.test(msg)) {
    code = 'worktree_setup_error';
  } else if (/worker[_ ]dispatch|spawn|task dispatch|subagent dispatch/.test(msg)) {
    code = 'worker_dispatch_error';
  } else if (/wave[_ ]execution|phase[_ ]execution|worker.*failed/.test(msg)) {
    code = 'wave_execution_error';
  } else if (/reconcile/.test(msg)) {
    code = 'reconcile_required';
  } else if (/semantic[_ ]reentry/.test(msg)) {
    code = 'semantic_reentry_exhausted';
  }

  // Final safety belt — never return a code that's not in the allowlist.
  if (!FAILURE_CODE_ALLOWLIST.has(code)) code = 'unknown_runtime_error';
  return { ok: true, failure_code: code };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const subcommand = process.argv[2];
  if (!subcommand) {
    fail('MissingSubcommand', 'usage: scheduler-cli <subcommand> < input.json', null, 64);
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
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('MalformedStdin', 'stdin must be a JSON object', null, 64);
    return;
  }

  const cwd = resolveCwd(input, process.argv);

  let result;
  try {
    switch (subcommand) {
      case 'plan-wave':            result = subPlanWave(input); break;
      case 'validate-wave':        result = subValidateWave(input); break;
      case 'build-wave-state':     result = subBuildWaveState(input); break;
      case 'claim':                result = subClaim(input); break;
      case 'release':              result = subRelease(input); break;
      case 'dispatch-tick':        result = subDispatchTick(input); break;
      case 'project-state-rows':   result = subProjectStateRows(input); break;
      case 'detect-impact-drift':  result = subDetectImpactDrift(input); break;
      case 'record-event':         result = subRecordEvent(input, cwd); break;
      case 'classify-wave-failure': result = subClassifyWaveFailure(input); break;
      default:
        fail('UnknownSubcommand', `unrecognized subcommand: ${subcommand}`, { subcommand }, 64);
        return;
    }
  } catch (err) {
    // Unclassified throw — infra error.
    fail('UncaughtError', err?.message || String(err), { stack: err?.stack || null }, 2);
    return;
  }

  if (!result) return; // sub-* already emitted+exited via fail()
  emit(result);
  process.exit(result.ok ? 0 : 1);
}

// Re-export internal helpers so the test suite can import them without
// shelling out for every assertion. The CLI binary path stays the same.
export {
  subPlanWave,
  subValidateWave,
  subBuildWaveState,
  subClaim,
  subRelease,
  subDispatchTick,
  subProjectStateRows,
  subDetectImpactDrift,
  subRecordEvent,
  subClassifyWaveFailure,
};

// Only run main() when invoked directly. The import.meta.url check matches
// the workspace convention (mpl-decomposition-postprocess.mjs:863).
import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}

// Suppress unused-import warning for WAVE_REJECTION_CODES — kept for future
// rejection-code emission inside the CLI without re-importing.
void WAVE_REJECTION_CODES;
