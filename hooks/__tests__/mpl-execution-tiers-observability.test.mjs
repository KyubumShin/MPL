import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('execution_tiers observability contract', () => {
  it('requires scheduler telemetry for every tier decision', () => {
    const text = readFileSync(join(process.cwd(), 'commands', 'mpl-run-execute.md'), 'utf-8');
    assert.match(text, /record_scheduler_event/);
    assert.match(text, /\.mpl\/mpl\/profile\/phase-scheduler\.jsonl/);
    assert.match(text, /state\.phase_scheduler_history/);
    assert.match(text, /selected_mode.*parallel_rejected/s);
    assert.match(text, /Do not add a separate `phase_dependencies` field/);
  });

  it('every record_scheduler_event block carries pipeline_id + run_started_at + recompose_count + worker_cap + worktree_slots', () => {
    // Codex r1: worker_cap/worktree_slots missing from skipped+sequential.
    // Codex r3: pipeline_id added because JSONL profile is persistent.
    // Codex r4: pipeline_id alone is not unique (mpl-{date}-{slug} collides
    // on same-day same-feature reruns); add state.started_at as run_started_at
    // for genuine per-run uniqueness.
    const text = readFileSync(join(process.cwd(), 'commands', 'mpl-run-execute.md'), 'utf-8');
    const blockPattern = /record_scheduler_event\(\{[^}]*\}\)/gs;
    const blocks = text.match(blockPattern) || [];
    assert.ok(blocks.length >= 3,
      `expected at least 3 record_scheduler_event() blocks, found ${blocks.length}`);
    for (const block of blocks) {
      assert.match(block, /pipeline_id/,
        `record_scheduler_event block missing pipeline_id:\n${block}`);
      assert.match(block, /run_started_at/,
        `record_scheduler_event block missing run_started_at:\n${block}`);
      assert.match(block, /recompose_count/,
        `record_scheduler_event block missing recompose_count:\n${block}`);
      assert.match(block, /wave_index/,
        `record_scheduler_event block missing wave_index:\n${block}`);
      assert.match(block, /timestamp: now_iso\(\)/,
        `record_scheduler_event block missing timestamp:\n${block}`);
      assert.match(block, /worker_cap/,
        `record_scheduler_event block missing worker_cap:\n${block}`);
      assert.match(block, /worktree_slots/,
        `record_scheduler_event block missing worktree_slots:\n${block}`);
    }
  });

  it('parallel-pool slot lifecycle uses state.worktree_pool_history (separate from HIGH-risk isolation worktree_history)', () => {
    // Claude review on PR #213: the new parallel-pool writer must not share
    // an array with the existing HIGH-risk isolation writer in
    // commands/mpl-run-execute-context.md §5 — the shapes are incompatible.
    const text = readFileSync(join(process.cwd(), 'commands', 'mpl-run-execute.md'), 'utf-8');
    assert.match(text, /append state\.worktree_pool_history entries/);
    assert.doesNotMatch(text, /append state\.worktree_history entries/,
      'parallel-pool writer must use worktree_pool_history, not worktree_history');
    assert.match(text, /slot_id/);
    assert.match(text, /worktree_path/);
  });

  it('finalize Step 5.4 wires phase-scheduler telemetry into run-summary scheduler block', () => {
    // Codex review on PR #213: the executor's "final run summary MUST explain
    // why phase parallelism was not used" needs an enforcement path. Pin the
    // finalize prompt + run-summary schema so the MUST is reachable.
    const finalize = readFileSync(join(process.cwd(), 'commands', 'mpl-run-finalize.md'), 'utf-8');
    assert.match(finalize, /phase-scheduler\.jsonl/);
    assert.match(finalize, /tiers_parallel_requested/);
    assert.match(finalize, /tiers_parallel_executed/);
    assert.match(finalize, /no_parallel_explanation/);

    const schemaText = readFileSync(join(process.cwd(), 'commands', 'schemas', 'run-summary.json'), 'utf-8');
    const schema = JSON.parse(schemaText);
    assert.ok(schema.scheduler, 'run-summary.json must include a scheduler example block');
    for (const k of ['tiers_total', 'tiers_parallel_requested', 'tiers_parallel_executed', 'tiers_parallel_rejected', 'tiers_with_missing_telemetry', 'waves_parallel_rejected', 'waves_parallel_failed', 'tiers_with_partial_rejection', 'rejection_reasons', 'no_parallel_explanation']) {
      assert.ok(k in schema.scheduler, `scheduler block missing required key: ${k}`);
    }
  });

  it('parallel event is emitted AFTER parallel_map success; pool/dispatch failures emit parallel_failed', () => {
    // Codex round-6 review on PR #213: emitting selected_mode:"parallel"
    // before ensure_worktree_pool/parallel_map run lets a setup or worker
    // failure leave a successful-looking row that satisfies the run
    // summary. The lifecycle must be:
    //   - wave.length == 1: emit parallel_rejected before single-phase exec
    //   - wave.length > 1: emit parallel AFTER parallel_map succeeds, or
    //                      parallel_failed in the catch branch
    const exec = readFileSync(join(process.cwd(), 'commands', 'mpl-run-execute.md'), 'utf-8');
    assert.match(exec, /parallel_failed/,
      'execute prompt must define a parallel_failed mode for pool/dispatch errors');
    assert.match(exec, /MUST NOT be emitted before the wave finishes successfully/,
      'execute prompt must state the lifecycle invariant in prose');
    // The parallel-event block must sit AFTER parallel_map(...) in the prompt.
    const parallelMapIdx = exec.indexOf('parallel_map(wave,');
    const parallelEventIdx = exec.indexOf('selected_mode: "parallel",');
    assert.ok(parallelMapIdx > 0, 'parallel_map(...) block must exist');
    assert.ok(parallelEventIdx > 0, 'selected_mode:"parallel" event must exist');
    assert.ok(parallelEventIdx > parallelMapIdx,
      'selected_mode:"parallel" event must appear AFTER the parallel_map(...) call in the executor prompt');

    const finalize = readFileSync(join(process.cwd(), 'commands', 'mpl-run-finalize.md'), 'utf-8');
    assert.match(finalize, /waves_parallel_failed/,
      'finalize aggregation must surface waves_parallel_failed');
    assert.match(finalize, /waves_parallel_failed > 0/,
      'no_parallel_explanation must trigger on parallel_failed waves');
  });

  it('no_parallel_explanation triggers on partial parallelism (executed < requested), not only on full miss', () => {
    // Codex round-7 review on PR #213: requiring tiers_parallel_executed == 0
    // lets a run with two parallel:true tiers where ONE parallelized and the
    // OTHER was rejected finalize with no_parallel_explanation = null.
    // The MUST must compare executed against requested.
    const finalize = readFileSync(join(process.cwd(), 'commands', 'mpl-run-finalize.md'), 'utf-8');
    assert.match(finalize, /tiers_parallel_executed < tiers_parallel_requested/,
      'no_parallel_explanation trigger must compare executed against requested');
    // The old full-miss-only trigger must NOT be the sole condition anymore.
    assert.doesNotMatch(finalize, /tiers_parallel_executed == 0 OR\n\s+tiers_with_missing_telemetry/,
      'no_parallel_explanation must not gate on executed == 0 alone');
    // The explanation string MUST name the rejected tier ids when partial.
    assert.match(finalize, /rejected tier ids/);
  });

  it('finalize unions JSONL events with state.phase_scheduler_history so a degraded JSONL cannot manufacture false missing telemetry', () => {
    // Codex round-7 review on PR #213: reading jsonl OR state.history means
    // if JSONL parses (even with stale or truncated rows), the state mirror
    // is never consulted. Union both sources and de-duplicate so degraded
    // writes on one side cannot fake missing telemetry.
    const finalize = readFileSync(join(process.cwd(), 'commands', 'mpl-run-finalize.md'), 'utf-8');
    assert.match(finalize, /jsonl_events =/);
    assert.match(finalize, /state_events = state\.phase_scheduler_history/);
    assert.match(finalize, /dedupe_by/);
    assert.match(finalize, /jsonl_events\.concat\(state_events\)/);
  });

  it('finalize handles missing/empty execution_tiers with the same legacy fallback as the executor', () => {
    // Codex round-6 review on PR #213: finalize read decomposition.execution_tiers
    // directly, but the executor still documents a synthesized fallback
    // when the field is missing/empty. A legacy or resumed run would have
    // crashed finalize aggregation before run-summary.json was written.
    const finalize = readFileSync(join(process.cwd(), 'commands', 'mpl-run-finalize.md'), 'utf-8');
    assert.match(finalize, /Mirror the executor's legacy fallback/);
    assert.match(finalize, /if not execution_tiers or execution_tiers\.length == 0/);
    assert.match(finalize, /decomposition\.phases\.map/);
  });

  it('finalize aggregation preserves wave-level partial rejection within a tier', () => {
    // Codex round-5 review on PR #213: one tier can split into multiple
    // waves and emit BOTH a parallel and a parallel_rejected event. The
    // tier-level rollup (tiers_parallel_rejected = requested - executed)
    // would otherwise treat the tier as fully executed and hide the
    // single-wave rejection — the exact partial-parallelism case the
    // telemetry is meant to surface. Pin the wave-level signal.
    const finalize = readFileSync(join(process.cwd(), 'commands', 'mpl-run-finalize.md'), 'utf-8');
    assert.match(finalize, /waves_parallel_rejected/);
    assert.match(finalize, /tiers_with_partial_rejection/);
    // The no_parallel_explanation MUST trigger when partial rejection occurs,
    // not only when full rejection or missing telemetry occurs.
    assert.match(finalize, /tiers_with_partial_rejection is non-empty/);
  });

  it('finalize filters scheduler events by pipeline_id + run_started_at + recompose_count so stale profile rows cannot satisfy a new run', () => {
    // Codex r3: `.mpl/mpl/profile/` is persistent — stale rows from prior
    // pipelines must drop out. r4: pipeline_id is mpl-{date}-{slug}, not
    // unique on same-day same-feature reruns; state.started_at is the
    // actual per-run key. r8: APPEND-MODE/RECOMPOSE-MODE rewrites
    // execution_tiers mid-run, so the same tier number can mean different
    // phases pre- vs post-recompose. Filter on all three keys so events
    // survive only when they belong to this exact run AT this decomposition
    // version.
    const exec = readFileSync(join(process.cwd(), 'commands', 'mpl-run-execute.md'), 'utf-8');
    assert.match(exec, /run_started_at` \(= `state\.started_at` at write time/,
      'execute prompt must require run_started_at on every event with the rationale');
    assert.match(exec, /pipeline_id` alone collides on same-day same-slug/,
      'execute prompt must document why pipeline_id alone is insufficient');
    assert.match(exec, /recompose_count` \(= `decomposition\.recompose_count` at write time/,
      'execute prompt must require recompose_count on every event');
    assert.match(exec, /APPEND-MODE\/RECOMPOSE-MODE rewrites/,
      'execute prompt must document why recompose_count is required');

    const finalize = readFileSync(join(process.cwd(), 'commands', 'mpl-run-finalize.md'), 'utf-8');
    assert.match(finalize, /e\.pipeline_id == state\.pipeline_id/,
      'finalize aggregation must filter events by pipeline_id');
    assert.match(finalize, /e\.run_started_at == state\.started_at/,
      'finalize aggregation must also filter events by run_started_at');
    assert.match(finalize, /e\.recompose_count == decomposition\.recompose_count/,
      'finalize aggregation must also filter events by recompose_count');
    assert.match(finalize, /persistent across pipeline starts/,
      'finalize must explain why the filter exists so the contract cannot regress');
  });

  it('finalize derives tiers_parallel_requested from decomposition.yaml, not from the event log', () => {
    // Codex round-2 review on PR #213: deriving the denominator from the
    // event log lets a run with empty/missing telemetry silently pass the
    // no-parallel MUST with tiers_parallel_requested == 0. The truth lives
    // in decomposition.execution_tiers[].parallel; the event log is only
    // the evidence-of-execution side. Pin the aggregation prompt so the
    // denominator cannot regress back to event-only.
    const finalize = readFileSync(join(process.cwd(), 'commands', 'mpl-run-finalize.md'), 'utf-8');
    assert.match(finalize, /decomposition\.yaml/);
    assert.match(finalize, /execution_tiers\[\]\.parallel == true/);
    assert.match(finalize, /tiers_with_missing_telemetry/);
    // The MUST must trigger when telemetry is missing for a parallel-requested
    // tier, not only when an event with selected_mode:"parallel" is absent.
    assert.match(finalize, /tiers_with_missing_telemetry is\s*non-empty/);
  });
});
