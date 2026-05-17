import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { parseE2EScenariosText } from '../mpl-require-e2e-authenticity.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-e2e-authenticity.mjs');
const SCHEMA_V = CURRENT_SCHEMA_VERSION;

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-e2e-auth-'));
  mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: SCHEMA_V,
    current_phase: 'phase5-finalize',
  }));
  writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function goalContract() {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Build with real E2E"
  project_pivot: "No mock completion"
  must_ship_outcomes:
    - "real E2E"
ontology:
  entities:
    - app
variation_axes:
  - id: AX-1
acceptance_criteria:
  - id: AC-1
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
    - .mpl/mpl/profile/run-summary.json
    - .mpl/mpl/RUNBOOK.md
  require_commit: false
  require_finalize_timestamps: true
`;
}

function writeScenarios(text) {
  writeFileSync(join(tmp, '.mpl', 'mpl', 'e2e-scenarios.yaml'), text);
}

function runHook({ toolName = 'Write', toolInput = null } = {}) {
  const input = {
    cwd: tmp,
    tool_name: toolName,
    tool_input: toolInput || {
      file_path: '.mpl/state.json',
      content: JSON.stringify({ current_phase: 'phase5-finalize', finalize_done: true }),
    },
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

describe('parseE2EScenariosText', () => {
  it('parses authenticity fields', () => {
    const scenarios = parseE2EScenariosText(`
e2e_scenarios:
  - id: E2E-1
    required: true
    test_command: "npm run e2e"
    runtime_class: real_desktop
    mock_allowed: false
    launcher_evidence: "electron.launch"
    assertion_evidence: "persists after restart"
    test_files:
      - tests/e2e/app.spec.ts
`);
    assert.equal(scenarios.length, 1);
    assert.equal(scenarios[0].runtime_class, 'real_desktop');
    assert.deepEqual(scenarios[0].test_files, ['tests/e2e/app.spec.ts']);
  });
});

describe('mpl-require-e2e-authenticity hook', () => {
  it('exp19 regression: blocks real-runtime finalize when no E2E scenarios exist', () => {
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /required_e2e_scenario_missing/);
  });

  it('allows real runtime scenarios with assertion evidence', () => {
    writeScenarios(`
e2e_scenarios:
  - id: E2E-1
    required: true
    test_command: "npm run e2e"
    runtime_class: real_desktop
    mock_allowed: false
    launcher_evidence: "electron.launch"
    assertion_evidence: "restart survival assertion"
`);
    const r = runHook();
    assert.equal(r.continue, true);
  });

  it('blocks missing runtime class', () => {
    writeScenarios(`
e2e_scenarios:
  - id: E2E-1
    required: true
    test_command: "npm run e2e"
    launcher_evidence: "playwright chromium"
    assertion_evidence: "visible result"
`);
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /runtime_class=missing/);
  });

  it('blocks MultiEdit finalize writes', () => {
    writeScenarios(`
e2e_scenarios:
  - id: E2E-1
    required: true
    test_command: "npm run e2e"
    launcher_evidence: "playwright chromium"
    assertion_evidence: "visible result"
`);
    const r = runHook({
      toolName: 'MultiEdit',
      toolInput: {
        file_path: '.mpl/state.json',
        edits: [{
          old_string: '"finalize_done": false',
          new_string: '"finalize_done": true',
        }],
      },
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /runtime_class=missing/);
  });

  it('blocks mock-token commands when mock_allowed is false', () => {
    writeScenarios(`
e2e_scenarios:
  - id: E2E-1
    required: true
    test_command: "VITE_E2E_MOCK=1 npm run e2e"
    runtime_class: real_web
    mock_allowed: false
    launcher_evidence: "playwright"
    assertion_evidence: "visible result"
`);
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /mock_token_in_command/);
  });

  it('blocks placeholder assertions in declared test files', () => {
    mkdirSync(join(tmp, 'tests', 'e2e'), { recursive: true });
    writeFileSync(join(tmp, 'tests', 'e2e', 'app.spec.ts'), 'test("x", () => expect(true).toBe(true));\n');
    writeScenarios(`
e2e_scenarios:
  - id: E2E-1
    required: true
    test_command: "npm run e2e"
    runtime_class: real_web
    mock_allowed: false
    launcher_evidence: "playwright"
    test_files:
      - tests/e2e/app.spec.ts
`);
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /placeholder_assertion/);
  });

  it('blocks Tauri v2 IPC projects without capabilities JSON', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    mkdirSync(join(tmp, 'src-tauri', 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src-tauri', 'tauri.conf.json'), '{"productName":"app"}\n');
    writeFileSync(join(tmp, 'src', 'App.tsx'), 'import { invoke } from "@tauri-apps/api/core";\ninvoke("project_new");\n');
    writeFileSync(join(tmp, 'src-tauri', 'src', 'lib.rs'), '#[tauri::command]\nfn project_new() {}\n');
    writeScenarios(`
e2e_scenarios:
  - id: E2E-1
    required: true
    test_command: "npm run e2e"
    runtime_class: real_desktop
    mock_allowed: false
    launcher_evidence: "tauri app launch"
    assertion_evidence: "project_new IPC succeeds from UI"
`);
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /tauri_capabilities_missing/);
  });

  it('allows Tauri IPC projects when a capabilities JSON exists', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    mkdirSync(join(tmp, 'src-tauri', 'src'), { recursive: true });
    mkdirSync(join(tmp, 'src-tauri', 'capabilities'), { recursive: true });
    writeFileSync(join(tmp, 'src-tauri', 'tauri.conf.json'), '{"productName":"app"}\n');
    writeFileSync(join(tmp, 'src', 'App.tsx'), 'import { invoke } from "@tauri-apps/api/core";\ninvoke("project_new");\n');
    writeFileSync(join(tmp, 'src-tauri', 'src', 'lib.rs'), '#[tauri::command]\nfn project_new() {}\n');
    writeFileSync(join(tmp, 'src-tauri', 'capabilities', 'default.json'), '{"identifier":"default","permissions":["core:default"]}\n');
    writeScenarios(`
e2e_scenarios:
  - id: E2E-1
    required: true
    test_command: "npm run e2e"
    runtime_class: real_desktop
    mock_allowed: false
    launcher_evidence: "tauri app launch"
    assertion_evidence: "project_new IPC succeeds from UI"
`);
    const r = runHook();
    assert.equal(r.continue, true);
  });
});
