import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-finalize-artifacts.mjs');
const SCHEMA_V = CURRENT_SCHEMA_VERSION;

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-finalize-art-'));
  mkdirSync(join(tmp, '.mpl', 'mpl', 'profile'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: SCHEMA_V,
    current_phase: 'phase5-finalize',
    security_results: {
      dependency_audit: { command: 'npm audit --omit=dev', exit_code: 0 },
    },
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
  goal: "Finalize with machine evidence"
  project_pivot: "No false completion"
  must_ship_outcomes:
    - "final artifacts exist"
ontology:
  entities:
    - finalization
variation_axes:
  - id: AX-1
acceptance_criteria:
  - id: AC-1
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: true
  checks:
    - dependency_audit
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
    - .mpl/mpl/profile/run-summary.json
    - .mpl/mpl/RUNBOOK.md
  require_commit: false
  require_finalize_timestamps: true
`;
}

function writeArtifacts() {
  writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'profile', 'run-summary.json'), JSON.stringify({ run_id: 'r1' }));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
}

function runHook(content = null) {
  const stateContent = content || JSON.stringify({
    current_phase: 'phase5-finalize',
    finalize_done: true,
    completed_at: '2026-05-17T00:00:00Z',
    finalized_at: '2026-05-17T00:00:01Z',
  });
  const input = {
    cwd: tmp,
    tool_name: 'Write',
    tool_input: {
      file_path: '.mpl/state.json',
      content: stateContent,
    },
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

describe('mpl-require-finalize-artifacts hook', () => {
  it('allows finalize when declared artifacts, timestamps, and security evidence exist', () => {
    writeArtifacts();
    const r = runHook();
    assert.equal(r.continue, true);
  });

  it('blocks when run-summary is missing', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /run-summary\.json/);
  });

  it('blocks when RUNBOOK lacks the final section', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'profile', 'run-summary.json'), JSON.stringify({ run_id: 'r1' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n');
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /Pipeline Complete/);
  });

  it('blocks when required security evidence is missing', () => {
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
      schema_version: SCHEMA_V,
      current_phase: 'phase5-finalize',
      security_results: {},
    }));
    writeArtifacts();
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /security:dependency_audit/);
  });

  it('blocks when finalize timestamps are not in the candidate state', () => {
    writeArtifacts();
    const r = runHook(JSON.stringify({ current_phase: 'phase5-finalize', finalize_done: true }));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /state\.completed_at/);
    assert.match(r.reason, /state\.finalized_at/);
  });
});
