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

  it('requires worktree_history entries for parallel slot creation or reuse', () => {
    const text = readFileSync(join(process.cwd(), 'commands', 'mpl-run-execute.md'), 'utf-8');
    assert.match(text, /append state\.worktree_history entries/);
    assert.match(text, /slot_id/);
    assert.match(text, /worktree_path/);
  });
});
