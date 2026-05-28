import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';
import { validateBrief } from '../lib/mpl-test-agent-brief.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-test-agent-brief.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-brief-'));
  mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'phase2-sprint',
  }));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-1
    phase_domain: api
    test_agent_required: true
    test_agent_rationale: "touches a boundary"
    interface_contract:
      requires: []
      produces:
        - symbol: createWidget
          path: src/api/widgets.ts
  - id: phase-2
    phase_domain: docs
    test_agent_required: false
    test_agent_rationale: "documentation only"
`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function runHook(toolInput) {
  const input = {
    cwd: tmp,
    tool_name: 'Task',
    tool_input: toolInput,
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

function setBlockMode() {
  mkdirSync(join(tmp, '.mpl', 'config'), { recursive: true });
  writeFileSync(
    join(tmp, '.mpl', 'config', 'test-agent-brief-enforcement.json'),
    JSON.stringify({ mode: 'block' }),
  );
}

function writeValidBrief(phaseId) {
  mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', phaseId), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', phaseId, 'test-agent-brief.yaml'), `
phase_id: ${phaseId}
phase_domain: api
phase_name: "Create widget"
target_implementation_files:
  - src/api/widgets.ts
interface_contracts:
  - symbol: createWidget
    path: src/api/widgets.ts
a_item_coverage:
  - id: A-1
    test_target: "POST /widgets returns 201 with valid body"
s_item_coverage:
  - id: S-1
    test_target: "POST /widgets returns 422 on missing field"
required_test_commands:
  - "npm test -- src/api/widgets.test.ts"
`);
}

/* ──────────────── validator unit tests ──────────────── */

describe('validateBrief (#212 MVP)', () => {
  function freshBrief(overrides = {}) {
    return {
      phase_id: 'phase-1',
      phase_domain: 'api',
      target_implementation_files: ['src/api/widgets.ts'],
      interface_contracts: [{ symbol: 'createWidget', path: 'src/api/widgets.ts' }],
      a_item_coverage: [{ id: 'A-1', test_target: 'POST /widgets returns 201' }],
      s_item_coverage: [{ id: 'S-1', test_target: 'POST /widgets returns 422' }],
      required_test_commands: ['npm test -- src/api/widgets.test.ts'],
      ...overrides,
    };
  }
  function toYaml(brief) {
    let out = '';
    for (const [k, v] of Object.entries(brief)) {
      if (Array.isArray(v)) {
        out += `${k}:\n`;
        for (const item of v) {
          if (item && typeof item === 'object') {
            const keys = Object.keys(item);
            out += `  - ${keys[0]}: "${String(item[keys[0]])}"\n`;
            for (const k2 of keys.slice(1)) {
              out += `    ${k2}: "${String(item[k2])}"\n`;
            }
          } else {
            out += `  - "${String(item)}"\n`;
          }
        }
      } else {
        out += `${k}: "${String(v)}"\n`;
      }
    }
    return out;
  }

  it('accepts a fully valid brief', () => {
    const r = validateBrief(toYaml(freshBrief()), { phaseId: 'phase-1' });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it('rejects missing A/S coverage', () => {
    const r = validateBrief(toYaml(freshBrief({ a_item_coverage: [] })), { phaseId: 'phase-1' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.includes('missing_a_item_coverage'));
  });

  it('rejects placeholder test_target', () => {
    const r = validateBrief(toYaml(freshBrief({
      a_item_coverage: [{ id: 'A-1', test_target: 'TODO' }],
    })), { phaseId: 'phase-1' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /a_item_coverage.*placeholder/.test(e)));
  });

  it('rejects placeholder required_test_commands (echo / true / too short)', () => {
    for (const cmd of ['echo done', 'true', ':', 'tbd']) {
      const r = validateBrief(toYaml(freshBrief({ required_test_commands: [cmd] })), { phaseId: 'phase-1' });
      assert.equal(r.valid, false, `must reject command: ${cmd}`);
    }
  });

  it('rejects phase_id mismatch when phaseId is supplied', () => {
    const r = validateBrief(toYaml(freshBrief({ phase_id: 'phase-9' })), { phaseId: 'phase-1' });
    assert.ok(r.errors.some((e) => /phase_id_mismatch/.test(e)));
  });

  it('rejects empty required_test_commands', () => {
    const r = validateBrief(toYaml(freshBrief({ required_test_commands: [] })), { phaseId: 'phase-1' });
    assert.ok(r.errors.includes('missing_required_test_commands'));
  });

  it('skips target_implementation_files requirement for documentation-only briefs (no interface_contracts)', () => {
    const r = validateBrief(toYaml(freshBrief({
      interface_contracts: [],
      target_implementation_files: [],
    })), { phaseId: 'phase-1' });
    // missing_target_implementation_files should NOT fire (no interface contracts)
    assert.ok(!r.errors.includes('missing_target_implementation_files'));
  });
});

/* ──────────────── hook integration tests ──────────────── */

describe('mpl-require-test-agent-brief hook (#212)', () => {
  it('SCENARIO 1 (block default after #225 cutover): missing brief for test_agent_required:true → block', () => {
    // #225 cutover: producer (mechanical postprocess) now ships briefs,
    // so default flips from `warn` to `block`. Operators can still
    // opt back to `warn` via .mpl/config/test-agent-brief-enforcement.json.
    //
    // Codex r1 on PR #226: missing-brief paths attempt lazy generation
    // first. Minimal fixture decomposition has no verification_plan, so
    // the lazy-generated brief fails schema validation. Either reason
    // (missing or invalid) is the correct gate signal.
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1 from the contract.',
    });
    assert.equal(r.continue, false);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /\[MPL #212\]/);
    assert.match(r.reason, /phase-1/);
    assert.match(r.reason, /brief artifact missing|brief failed schema validation/);
  });

  it('SCENARIO 1b (explicit warn mode): missing or invalid brief → systemMessage only', () => {
    mkdirSync(join(tmp, '.mpl', 'config'), { recursive: true });
    writeFileSync(
      join(tmp, '.mpl', 'config', 'test-agent-brief-enforcement.json'),
      JSON.stringify({ mode: 'warn' }),
    );
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1 from the contract.',
    });
    assert.equal(r.continue, true);
    assert.match(r.systemMessage, /\[MPL #212\]/);
  });

  it('SCENARIO 1 (block mode, no verification_plan in fixture): falls through to schema validation', () => {
    setBlockMode();
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1 from the contract.',
    });
    assert.equal(r.continue, false);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /brief artifact missing|brief failed schema validation/);
    assert.match(r.reason, /test-agent-brief\.yaml/);
  });

  it('SCENARIO 2: invalid brief missing A/S coverage → block with errors (block mode)', () => {
    setBlockMode();
    mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'test-agent-brief.yaml'), `
phase_id: phase-1
target_implementation_files:
  - src/api/widgets.ts
interface_contracts:
  - symbol: createWidget
required_test_commands:
  - "npm test"
`);
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1 from the contract.',
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /missing_a_item_coverage/);
    assert.match(r.reason, /missing_s_item_coverage/);
  });

  it('SCENARIO 3: invalid brief with placeholder command → block (block mode)', () => {
    setBlockMode();
    mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'test-agent-brief.yaml'), `
phase_id: phase-1
target_implementation_files:
  - src/api/widgets.ts
interface_contracts:
  - symbol: createWidget
a_item_coverage:
  - id: A-1
    test_target: "POST /widgets returns 201"
s_item_coverage:
  - id: S-1
    test_target: "POST /widgets returns 422"
required_test_commands:
  - echo done
`);
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1 from the contract.',
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /required_test_commands.*placeholder/);
  });

  it('enforcement mode off → silent even with missing brief (transitional debug)', () => {
    mkdirSync(join(tmp, '.mpl', 'config'), { recursive: true });
    writeFileSync(
      join(tmp, '.mpl', 'config', 'test-agent-brief-enforcement.json'),
      JSON.stringify({ mode: 'off' }),
    );
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1 from the contract.',
    });
    assert.equal(r.continue, true);
    assert.equal(r.suppressOutput, true);
  });

  it('SCENARIO 4: valid brief → pass', () => {
    writeValidBrief('phase-1');
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1 from the contract.',
    });
    assert.equal(r.continue, true);
    assert.equal(r.suppressOutput, true);
  });

  it('SCENARIO 5: decomposer does NOT need to ship runbook directly — phase with test_agent_required:false passes without a brief', () => {
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-2 from the contract.',
    });
    // phase-2 has test_agent_required: false; the brief gate must not fire.
    assert.equal(r.continue, true);
  });

  /* extra coverage */

  it('non-test-agent Task dispatch passes through', () => {
    const r = runHook({
      subagent_type: 'mpl-phase-runner',
      prompt: 'Execute phase-1.',
    });
    assert.equal(r.continue, true);
  });

  it('background test-agent dispatch is ALSO gated — codex r1 [logic] (PR #224)', () => {
    // codex r1 on PR #224: PreToolUse must NOT skip on run_in_background.
    // The brief precondition has to fire BEFORE the background dispatch
    // launches; no later PreToolUse event can stop an already-started run.
    //
    // After codex r1 on PR #226, missing-brief paths attempt lazy
    // generation from decomposition first. The minimal fixture
    // decomposition has only `interface_contract.produces` (no
    // verification_plan), so lazy generation produces a malformed brief
    // that the validator catches with schema errors. Either way (artifact
    // missing OR schema invalid), the gate fires — that's the property
    // being asserted.
    setBlockMode();
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1.',
      run_in_background: true,
    });
    assert.equal(r.continue, false);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /brief artifact missing|brief failed schema validation/);
  });

  it('background test-agent dispatch passes when brief IS valid', () => {
    writeValidBrief('phase-1');
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1.',
      run_in_background: true,
    });
    assert.equal(r.continue, true);
  });

  it('codex r1 [contract-break]: pre-existing workspace with decomposition but no briefs → lazy-generates and passes', () => {
    // Replace the minimal decomposition with one that has full verification_plan
    // so writeTestAgentBriefs can produce a valid brief.
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-1
    phase_domain: api
    phase_lang: typescript
    test_agent_required: true
    impact:
      modify:
        - path: src/api/widgets.ts
    interface_contract:
      produces:
        - symbol: createWidget
          path: src/api/widgets.ts
    verification_plan:
      a_items:
        - id: A-1
          statement: "POST /widgets returns 201 with a valid body"
      s_items:
        - id: S-1
          statement: "POST /widgets returns 422 on missing field"
`);
    // No brief file yet. Default mode is block.
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Verify phase-1 from the contract.',
    });
    // The lazy-generation path should have written the brief and let dispatch proceed.
    assert.equal(r.continue, true);
    assert.equal(r.suppressOutput, true);
  });

  it('prompt with no phase id passes through', () => {
    const r = runHook({
      subagent_type: 'mpl-test-agent',
      prompt: 'Generic test-agent task.',
    });
    assert.equal(r.continue, true);
  });
});
