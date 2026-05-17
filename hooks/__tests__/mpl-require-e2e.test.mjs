import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  parseUserContractText,
  computeUncoveredUcs,
} from '../mpl-require-e2e.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-e2e.mjs');

function goalContract({ realRuntimeRequired = true } = {}) {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Build app"
  project_pivot: "real runtime"
  must_ship_outcomes:
    - "usable app"
ontology:
  entities:
    - app
variation_axes:
  - id: AX-1
acceptance_criteria:
  - id: AC-1
e2e_policy:
  real_runtime_required: ${realRuntimeRequired ? 'true' : 'false'}
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/RUNBOOK.md
  require_commit: false
  require_finalize_timestamps: true
`;
}

function finalizeWriteInput(tmp, toolInput = null) {
  return {
    cwd: tmp,
    tool_name: 'Write',
    tool_input: toolInput || {
      file_path: '.mpl/state.json',
      content: JSON.stringify({ current_phase: 'phase5-finalize', finalize_done: true }),
    },
  };
}

function runHook(tmp, input = null) {
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input || finalizeWriteInput(tmp)),
    encoding: 'utf-8',
  }));
}

describe('parseUserContractText', () => {
  it('extracts included UC ids with explicit status', () => {
    const text = `
schema_version: 1
user_cases:
  - id: "UC-01"
    status: included
  - id: "UC-02"
    status: included
scenarios: []
`;
    const r = parseUserContractText(text);
    assert.deepEqual(r.included_uc_ids, ['UC-01', 'UC-02']);
  });

  it('defaults UC status to included when unspecified', () => {
    const text = `
user_cases:
  - id: "UC-05"
    title: "x"
  - id: "UC-06"
    title: "y"
`;
    const r = parseUserContractText(text);
    assert.deepEqual(r.included_uc_ids, ['UC-05', 'UC-06']);
  });

  it('excludes deferred and cut UCs', () => {
    const text = `
user_cases:
  - id: "UC-01"
    status: included
  - id: "UC-02"
    status: deferred
  - id: "UC-03"
    status: cut
`;
    const r = parseUserContractText(text);
    assert.deepEqual(r.included_uc_ids, ['UC-01']);
  });

  it('parses scenarios with inline covers and skip_allowed', () => {
    const text = `
scenarios:
  - id: "SC-01"
    covers: [UC-01, UC-02]
    skip_allowed: [ENV_API_DOWN]
  - id: "SC-02"
    covers: ["UC-03"]
    skip_allowed: []
`;
    const r = parseUserContractText(text);
    assert.equal(r.scenarios.length, 2);
    assert.deepEqual(r.scenarios[0].covers, ['UC-01', 'UC-02']);
    assert.deepEqual(r.scenarios[0].skip_allowed, ['ENV_API_DOWN']);
    assert.deepEqual(r.scenarios[1].covers, ['UC-03']);
    assert.deepEqual(r.scenarios[1].skip_allowed, []);
  });

  it('parses scenarios with block covers list', () => {
    const text = `
scenarios:
  - id: "SC-01"
    covers:
      - "UC-01"
      - "UC-02"
    skip_allowed:
      - ENV_API_DOWN
      - FLAKY_NETWORK
`;
    const r = parseUserContractText(text);
    assert.equal(r.scenarios.length, 1);
    assert.deepEqual(r.scenarios[0].covers, ['UC-01', 'UC-02']);
    assert.deepEqual(r.scenarios[0].skip_allowed, ['ENV_API_DOWN', 'FLAKY_NETWORK']);
  });

  it('handles multiple sections together', () => {
    const text = `
schema_version: 1
user_cases:
  - id: "UC-01"
    status: included
  - id: "UC-02"
    status: included
deferred_cases:
  - id: "UC-09"
    reason: "later"
scenarios:
  - id: "SC-01"
    covers: [UC-01]
  - id: "SC-02"
    covers: [UC-02]
`;
    const r = parseUserContractText(text);
    assert.deepEqual(r.included_uc_ids, ['UC-01', 'UC-02']);
    assert.equal(r.scenarios.length, 2);
  });

  it('returns empty for null/empty input', () => {
    assert.deepEqual(parseUserContractText(''), { included_uc_ids: [], scenarios: [] });
    assert.deepEqual(parseUserContractText(null), { included_uc_ids: [], scenarios: [] });
  });
});

describe('computeUncoveredUcs', () => {
  it('returns uncovered UCs when scenarios do not cover all', () => {
    const uncovered = computeUncoveredUcs(
      ['UC-01', 'UC-02', 'UC-03'],
      [{ id: 'SC-1', covers: ['UC-01'] }],
    );
    assert.deepEqual(uncovered, ['UC-02', 'UC-03']);
  });

  it('returns empty when all UCs are covered', () => {
    const uncovered = computeUncoveredUcs(
      ['UC-01', 'UC-02'],
      [
        { id: 'SC-1', covers: ['UC-01'] },
        { id: 'SC-2', covers: ['UC-02'] },
      ],
    );
    assert.deepEqual(uncovered, []);
  });

  it('counts cross-scenario coverage (union)', () => {
    const uncovered = computeUncoveredUcs(
      ['UC-01', 'UC-02'],
      [{ id: 'SC-1', covers: ['UC-01', 'UC-02'] }],
    );
    assert.deepEqual(uncovered, []);
  });

  it('handles scenarios with missing covers field', () => {
    const uncovered = computeUncoveredUcs(
      ['UC-01'],
      [{ id: 'SC-1' }], // no covers field
    );
    assert.deepEqual(uncovered, ['UC-01']);
  });

  it('returns empty when no included UCs', () => {
    const uncovered = computeUncoveredUcs([], [{ id: 'SC-1', covers: ['UC-01'] }]);
    assert.deepEqual(uncovered, []);
  });
});

describe('mpl-require-e2e hook integration', () => {
  it('exp19 regression: blocks finalize when real-runtime goal has zero E2E scenarios', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-require-e2e-zero-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase5-finalize',
        e2e_results: {},
      }));
      writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
      const r = runHook(tmp);
      assert.equal(r.decision, 'block');
      assert.match(r.reason, /requires real runtime E2E/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks required E2E scenarios missing executable test_command', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-require-e2e-command-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase5-finalize',
        e2e_results: {},
      }));
      writeFileSync(join(tmp, '.mpl', 'mpl', 'e2e-scenarios.yaml'), `
e2e_scenarios:
  - id: E2E-1
    required: true
`);
      const r = runHook(tmp);
      assert.equal(r.decision, 'block');
      assert.match(r.reason, /missing executable test_command: E2E-1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks included UCs when no executable E2E scenario exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-require-e2e-uc-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'requirements'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase5-finalize',
        e2e_results: {},
      }));
      writeFileSync(join(tmp, '.mpl', 'requirements', 'user-contract.md'), `
user_cases:
  - id: UC-01
    status: included
scenarios: []
`);
      const r = runHook(tmp);
      assert.equal(r.decision, 'block');
      assert.match(r.reason, /included UC/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks MultiEdit finalize writes when a required scenario never ran', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-require-e2e-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase5-finalize',
        e2e_results: {},
      }));
      writeFileSync(join(tmp, '.mpl', 'mpl', 'e2e-scenarios.yaml'), `
e2e_scenarios:
  - id: E2E-1
    required: true
    test_command: "npm run e2e"
`);
      const input = {
        cwd: tmp,
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: '.mpl/state.json',
          edits: [{
            old_string: '"finalize_done": false',
            new_string: '"finalize_done": true',
          }],
        },
      };
      const r = runHook(tmp, input);
      assert.equal(r.decision, 'block');
      assert.match(r.reason, /E2E-1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
