import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-validate-seed.mjs');

describe('mpl-validate-seed hook integration', () => {
  it('validates MultiEdit writes to seed YAML files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-seed-hook-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
      }));

      const input = {
        cwd: tmp,
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: '.mpl/seeds/phase-1.yaml',
          edits: [{
            old_string: 'old',
            new_string: 'phase_seed:\n  goal: "ship"\n',
          }],
        },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, true);
      assert.match(r.hookSpecificOutput?.additionalContext || '', /SEED VALIDATION FAILED/);
      assert.match(r.hookSpecificOutput?.additionalContext || '', /acceptance_criteria/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
