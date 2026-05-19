import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  validateSeed,
  validateTodoSchedulingFields,
} from '../mpl-validate-seed.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-validate-seed.mjs');

function validSeedYaml() {
  return `phase_seed:
  goal: "ship"
  acceptance_criteria:
    - "AC-1"
  mini_plan_seed:
    todo_structure:
      - id: todo-1
        description: "Implement feature"
        depends_on: []
        files_to_modify:
          - src/app.ts
        resource_locks: []
  exit_conditions:
    - type: command
      command: "npm test"
`;
}

describe('seed TODO scheduling validation', () => {
  it('requires depends_on, files_to_modify, and resource_locks on every TODO', () => {
    const missing = validateTodoSchedulingFields(`phase_seed:
  goal: "ship"
  acceptance_criteria:
    - "AC-1"
  mini_plan_seed:
    todo_structure:
      - id: todo-1
        description: "Implement feature"
        depends_on: []
      - id: todo-2
        description: "Add tests"
        files_to_modify: []
        resource_locks: []
  exit_conditions:
    - type: command
      command: "npm test"
`);
    assert.deepEqual(missing, [
      'phase_seed.mini_plan_seed.todo_structure[todo-1].files_to_modify',
      'phase_seed.mini_plan_seed.todo_structure[todo-1].resource_locks',
      'phase_seed.mini_plan_seed.todo_structure[todo-2].depends_on',
    ]);
  });

  it('accepts empty dependency and resource arrays when the fields are explicit', () => {
    assert.deepEqual(validateTodoSchedulingFields(validSeedYaml()), []);
    assert.equal(validateSeed(validSeedYaml()).valid, true);
  });
});

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

  it('validates actual phase-seed and chain-seed write paths', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-seed-hook-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
      }));

      for (const file_path of [
        '.mpl/mpl/phases/phase-1/phase-seed.yaml',
        '.mpl/mpl/chains/chain-1/chain-seed.yaml',
      ]) {
        const input = {
          cwd: tmp,
          tool_name: 'Write',
          tool_input: {
            file_path,
            content: validSeedYaml().replace('        resource_locks: []\n', ''),
          },
        };
        const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
          input: JSON.stringify(input),
          encoding: 'utf-8',
        }));
        assert.equal(r.continue, true);
        assert.match(r.hookSpecificOutput?.additionalContext || '', /resource_locks/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
