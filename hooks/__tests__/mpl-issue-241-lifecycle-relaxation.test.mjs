// #241 — over-enforcement audit B-tier relaxation.
// Covers B1 (load-bearing field scoped immutability) and B6 (PLAN.md
// `[~]` deferred recognition). B2/B3/B4 are tracked as follow-up
// sub-issues (advisory stopReason for active-cohort + stagnation,
// complete_pipeline_optional finalize acceptance) — see PR body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

import {
  validateCompletedPhaseImmutability,
  normalizePhaseBlock,
  COMPLETED_PHASE_LOAD_BEARING_FIELDS,
} from '../lib/mpl-completed-phase-immutability.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOKS_DIR = dirname(__dirname);

function freshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-241-'));
  mkdirSync(join(dir, '.mpl'), { recursive: true });
  mkdirSync(join(dir, '.mpl', 'mpl'), { recursive: true });
  // Bypass I13 Phase 0 artifact requirement so the routing assertions
  // can fire — materialize the required Phase 0 artifacts plus the
  // no-boundaries opt-out for contracts.
  mkdirSync(join(dir, '.mpl', 'contracts'), { recursive: true });
  mkdirSync(join(dir, '.mpl', 'mpl', 'phase0'), { recursive: true });
  writeFileSync(
    join(dir, '.mpl', 'contracts', '_no-boundaries.json'),
    '{"opt_out_reason": "test-fixture: no boundary inputs"}',
  );
  writeFileSync(join(dir, '.mpl', 'mpl', 'phase0', 'raw-scan.md'), '# scan\n');
  writeFileSync(
    join(dir, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'),
    'goal: test\n',
  );
  writeFileSync(
    join(dir, '.mpl', 'state.json'),
    JSON.stringify(
      { current_phase: 'phase2-sprint', execution: { phases: { completed: 0 } } },
      null,
      2,
    ),
  );
  return dir;
}

test('#241 B1: load-bearing fields set is the closed, exported allowlist', () => {
  // Must include all 6 fields named in the acceptance criteria.
  for (const f of [
    'interface_contract',
    'depends_on',
    'impact',
    'acceptance_criteria',
    'variation_axes',
    'id',
  ]) {
    assert.ok(
      COMPLETED_PHASE_LOAD_BEARING_FIELDS.has(f),
      `Expected ${f} in load-bearing set`,
    );
  }
  // Presentation-only fields must NOT be load-bearing.
  for (const f of ['name', 'notes', 'description', 'rationale', 'test_agent_rationale']) {
    assert.ok(
      !COMPLETED_PHASE_LOAD_BEARING_FIELDS.has(f),
      `Did NOT expect ${f} in load-bearing set`,
    );
  }
});

test('#241 B1: comment edit in a completed phase is allowed', () => {
  const oldText = `
phases:
  - id: phase-1
    name: First
    impact: high
    interface_contract:
      produces:
        - type: artifact
          name: out_a
  - id: phase-2
    name: Second
    impact: low
`;
  const newText = `
phases:
  - id: phase-1
    # comment added later by an editor
    name: First
    impact: high
    interface_contract:
      produces:
        - type: artifact
          name: out_a
  - id: phase-2
    name: Second
    impact: low
`;
  const verdict = validateCompletedPhaseImmutability({
    oldText,
    newText,
    completedIds: ['phase-1'],
  });
  assert.equal(verdict.valid, true, verdict.issues.join(', '));
});

test('#241 B1: whitespace / blank-line additions in a completed phase are allowed', () => {
  const oldText = `
phases:
  - id: phase-1
    impact: high
    interface_contract:
      produces:
        - type: artifact
          name: out_a
`;
  const newText = `
phases:
  - id: phase-1
    impact: high${'   '}

    interface_contract:
      produces:
        - type: artifact
          name: out_a
`;
  const verdict = validateCompletedPhaseImmutability({
    oldText,
    newText,
    completedIds: ['phase-1'],
  });
  assert.equal(verdict.valid, true, verdict.issues.join(', '));
});

test('#241 B1: notes field can be added to a completed phase without violating immutability', () => {
  const oldText = `
phases:
  - id: phase-1
    impact: high
    interface_contract:
      produces:
        - type: artifact
          name: out_a
`;
  const newText = `
phases:
  - id: phase-1
    impact: high
    notes: |
      free-form notes added later by an operator
      with multiple lines
    interface_contract:
      produces:
        - type: artifact
          name: out_a
`;
  const verdict = validateCompletedPhaseImmutability({
    oldText,
    newText,
    completedIds: ['phase-1'],
  });
  assert.equal(verdict.valid, true, verdict.issues.join(', '));
});

test('#241 B1: interface_contract.produces[].name change in a completed phase IS blocked', () => {
  const oldText = `
phases:
  - id: phase-1
    impact: high
    interface_contract:
      produces:
        - type: artifact
          name: out_a
`;
  const newText = `
phases:
  - id: phase-1
    impact: high
    interface_contract:
      produces:
        - type: artifact
          name: renamed_artifact
`;
  const verdict = validateCompletedPhaseImmutability({
    oldText,
    newText,
    completedIds: ['phase-1'],
  });
  assert.equal(verdict.valid, false);
  assert.ok(verdict.issues.includes('phase-1:contract:modified'));
});

test('#241 B1: depends_on / acceptance_criteria / variation_axes / scope changes are blocked', () => {
  for (const field of ['depends_on', 'acceptance_criteria', 'variation_axes', 'scope']) {
    const oldText = `
phases:
  - id: phase-1
    impact: high
    ${field}: original
`;
    const newText = `
phases:
  - id: phase-1
    impact: high
    ${field}: modified
`;
    const verdict = validateCompletedPhaseImmutability({
      oldText,
      newText,
      completedIds: ['phase-1'],
    });
    assert.equal(verdict.valid, false, `Expected ${field} change to be blocking`);
    assert.ok(verdict.issues.includes('phase-1:contract:modified'));
  }
});

test('#241 B1: normalizePhaseBlock produces identical output for blocks differing only in non-load-bearing fields', () => {
  const a = `
  - id: phase-1
    name: A
    impact: high
    notes: |
      one
      two
    interface_contract:
      produces:
        - type: artifact
          name: out
`;
  const b = `
  - id: phase-1
    # comment added
    name: B
    impact: high
    description: completely rewritten
    notes: |
      a totally different note body
    interface_contract:
      produces:
        - type: artifact
          name: out
`;
  assert.equal(normalizePhaseBlock(a), normalizePhaseBlock(b));
});

// ---------- B6: PLAN.md `[~]` deferred recognition ----------

function runPhaseController(cwd) {
  const out = execFileSync(
    'node',
    [join(HOOKS_DIR, 'mpl-phase-controller.mjs')],
    {
      input: JSON.stringify({ cwd, hook_event_name: 'Stop' }),
      cwd,
      encoding: 'utf-8',
    },
  );
  return JSON.parse(out.trim());
}

test('#241 B6: PLAN.md with all [x] and one [~] deferred routes to phase3-gate with deferred_count surfaced', () => {
  const cwd = freshWorkspace();
  try {
    writeFileSync(
      join(cwd, 'PLAN.md'),
      [
        '# Plan',
        '### [x] Task 1: implement feature',
        '### [x] Task 2: write tests',
        '### [~] Task 3: deferred polish',
      ].join('\n'),
    );
    const decision = runPhaseController(cwd);
    assert.equal(decision.continue, true);
    assert.ok(decision.stopReason.includes('1 deferred'),
      `expected stopReason to surface deferred count, got: ${decision.stopReason}`);
    // 2/3 completed + 1 deferred = no remaining → routes (target language).
    assert.ok(
      /Transitioning to/.test(decision.stopReason),
      `expected transition, got: ${decision.stopReason}`,
    );
    // Confirm routing actually moved the phase.
    const state = JSON.parse(readFileSync(join(cwd, '.mpl', 'state.json'), 'utf-8'));
    assert.notEqual(state.current_phase, 'phase2-sprint');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#241 B6: PLAN.md with [~] still leaves remaining when other TODOs incomplete', () => {
  const cwd = freshWorkspace();
  try {
    writeFileSync(
      join(cwd, 'PLAN.md'),
      [
        '# Plan',
        '### [x] Task 1: done',
        '### [ ] Task 2: still pending',
        '### [~] Task 3: deferred polish',
      ].join('\n'),
    );
    const decision = runPhaseController(cwd);
    assert.equal(decision.continue, true);
    assert.match(decision.stopReason, /Sprint in progress/);
    assert.match(decision.stopReason, /1 deferred/);
    assert.match(decision.stopReason, /1 remaining/);
    // No routing transition occurred.
    const state = JSON.parse(readFileSync(join(cwd, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(state.current_phase, 'phase2-sprint');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#241 B6: PLAN.md with no deferred TODOs preserves existing stopReason shape (no deferred suffix)', () => {
  const cwd = freshWorkspace();
  try {
    writeFileSync(
      join(cwd, 'PLAN.md'),
      [
        '# Plan',
        '### [x] Task 1: done',
        '### [x] Task 2: also done',
      ].join('\n'),
    );
    const decision = runPhaseController(cwd);
    assert.equal(decision.continue, true);
    assert.ok(!decision.stopReason.includes('deferred'),
      `did NOT expect deferred suffix, got: ${decision.stopReason}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
