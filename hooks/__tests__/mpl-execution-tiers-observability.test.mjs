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

  it('skipped, sequential, parallel, and parallel_rejected events all carry worker_cap + worktree_slots', () => {
    // Codex review on PR #213: the mandatory-fields paragraph lists worker_cap
    // and worktree_slots, but earlier examples omitted them for skipped /
    // sequential events. Pin the executor prompt so every documented event
    // block actually includes those fields.
    const text = readFileSync(join(process.cwd(), 'commands', 'mpl-run-execute.md'), 'utf-8');
    const blockPattern = /record_scheduler_event\(\{[^}]*\}\)/gs;
    const blocks = text.match(blockPattern) || [];
    assert.ok(blocks.length >= 3,
      `expected at least 3 record_scheduler_event() blocks, found ${blocks.length}`);
    for (const block of blocks) {
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
    for (const k of ['tiers_total', 'tiers_parallel_requested', 'tiers_parallel_executed', 'tiers_parallel_rejected', 'tiers_with_missing_telemetry', 'rejection_reasons', 'no_parallel_explanation']) {
      assert.ok(k in schema.scheduler, `scheduler block missing required key: ${k}`);
    }
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
