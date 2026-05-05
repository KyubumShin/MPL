import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-keyword-detector.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-uic-'));
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function seedState(state) {
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'phase2-sprint',
    run_mode: 'auto',
    user_intervention_count: 0,
    fix_loop_history: [],
    ...state,
  }));
}

function runHook(promptText) {
  const stdin = JSON.stringify({
    cwd: tmp,
    hook_event_name: 'UserPromptSubmit',
    prompt: promptText,
  });
  execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
}

function readPersistedState() {
  return JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
}

describe('G6 (#114) user_intervention_count', () => {
  it('increments on UserPromptSubmit when MPL active + run_mode=auto', () => {
    seedState({});
    runHook('what is the status?');
    assert.equal(readPersistedState().user_intervention_count, 1);
  });

  it('accumulates across multiple prompts', () => {
    seedState({});
    runHook('first nudge');
    runHook('second nudge');
    runHook('third nudge');
    assert.equal(readPersistedState().user_intervention_count, 3);
  });

  it('does NOT increment when run_mode is full (manual)', () => {
    seedState({ run_mode: 'full' });
    runHook('regular driver prompt');
    assert.equal(readPersistedState().user_intervention_count, 0);
  });

  it('does NOT increment when pipeline is completed', () => {
    seedState({ current_phase: 'completed' });
    runHook('post-pipeline prompt');
    assert.equal(readPersistedState().user_intervention_count, 0);
  });

  it('does NOT increment when pipeline is cancelled', () => {
    seedState({ current_phase: 'cancelled' });
    runHook('post-cancel prompt');
    assert.equal(readPersistedState().user_intervention_count, 0);
  });

  it('does NOT throw when no state file exists (fresh workspace)', () => {
    // No seedState — .mpl/state.json absent.
    assert.doesNotThrow(() => runHook('mpl new feature'));
  });

  it('counts /mpl:mpl-status, /mpl:mpl-resume, /mpl:mpl-cancel — every operator prompt', () => {
    // Per spec G6 "sleep / nudge / cancel 모두 포함" — all interventions
    // count, including status checks and slash commands. The keyword
    // detector returns early for SLASH_NO_INIT but the increment fires
    // BEFORE that branch.
    seedState({});
    runHook('/mpl:mpl-status');
    runHook('/mpl:mpl-resume');
    runHook('/mpl:mpl-cancel reason');
    assert.equal(readPersistedState().user_intervention_count, 3);
  });
});
