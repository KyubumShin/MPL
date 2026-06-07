/**
 * Tests for hooks/lib/policy/contracts.mjs (Move #8 Phase A).
 *
 * Synthetic state + cwd fixtures. The 13 require-* hooks are NOT yet
 * delegating to this module — these tests validate the policy module
 * in isolation against the same inputs the wrappers will eventually
 * pass in Phase B.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  handle,
  handleChainAssignment,
  handleCovers,
  handleGoalTrace,
  handlePhaseContractGraph,
  handleReviewer,
  handleTestAgentBrief,
  handleTestAgentPostRun,
  handleE2eGate,
  handleE2eAuthenticity,
  handleFinalizeArtifacts,
  handleWholeGoalClosure,
} from '../lib/policy/contracts.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-policy-contracts-'));
  mkdirSync(join(dir, '.mpl', 'mpl'), { recursive: true });
  return dir;
}

test('handleChainAssignment: allow when chain_seed disabled', () => {
  const dir = fresh();
  try {
    const d = handleChainAssignment({
      cwd: dir,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-seed-generator' },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleChainAssignment: block when enabled but artifact missing', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'config.json'),
      JSON.stringify({ chain_seed: { enabled: true } }),
    );
    const d = handleChainAssignment({
      cwd: dir,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-seed-generator' },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'chain_assignment_missing');
    assert.equal(d.artifact, '.mpl/mpl/chain-assignment.yaml');
    assert.ok(d.reason.includes('AP-CHAIN-01'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleChainAssignment: allow when artifact present', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'config.json'),
      JSON.stringify({ chain_seed: { enabled: true } }),
    );
    writeFileSync(join(dir, '.mpl', 'mpl', 'chain-assignment.yaml'), 'chains: []');
    const d = handleChainAssignment({
      cwd: dir,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-seed-generator' },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleCovers: block when phase missing covers entry', () => {
  const dir = fresh();
  try {
    mkdirSync(join(dir, '.mpl', 'requirements'), { recursive: true });
    writeFileSync(join(dir, '.mpl', 'requirements', 'user-contract.md'), '');
    const yamlText = `phases:
  - id: phase-1
    name: A
    covers: []
`;
    const d = handleCovers({
      cwd: dir,
      toolInput: { file_path: '.mpl/mpl/decomposition.yaml', content: yamlText },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'covers_schema_violation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleCovers: allow with valid UC-NN entries', () => {
  const dir = fresh();
  try {
    mkdirSync(join(dir, '.mpl', 'requirements'), { recursive: true });
    writeFileSync(join(dir, '.mpl', 'requirements', 'user-contract.md'), '');
    const yamlText = `phases:
  - id: phase-1
    name: A
    covers: [UC-01, UC-02]
`;
    const d = handleCovers({
      cwd: dir,
      toolInput: { file_path: '.mpl/mpl/decomposition.yaml', content: yamlText },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleCovers: allow internal entry', () => {
  const dir = fresh();
  try {
    mkdirSync(join(dir, '.mpl', 'requirements'), { recursive: true });
    writeFileSync(join(dir, '.mpl', 'requirements', 'user-contract.md'), '');
    const yamlText = `phases:
  - id: phase-1
    name: A
    covers: [internal]
`;
    const d = handleCovers({
      cwd: dir,
      toolInput: { file_path: '.mpl/mpl/decomposition.yaml', content: yamlText },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleGoalTrace: block when goal contract is missing', () => {
  const dir = fresh();
  try {
    const yamlText = `phases:
  - id: phase-1
    name: A
`;
    const d = handleGoalTrace({
      cwd: dir,
      toolInput: { file_path: '.mpl/mpl/decomposition.yaml', content: yamlText },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'goal_contract_invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleGoalTrace: respects legacy goal_trace_required=false', () => {
  const dir = fresh();
  try {
    const yamlText = `phases:
  - id: phase-1
    name: A
`;
    const d = handleGoalTrace({
      cwd: dir,
      toolInput: { file_path: '.mpl/mpl/decomposition.yaml', content: yamlText },
      state: {},
      config: { goal_trace_required: false },
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handlePhaseContractGraph: block when graph metadata missing', () => {
  const dir = fresh();
  try {
    const yamlText = `phases:
  - id: phase-1
    name: A
`;
    const d = handlePhaseContractGraph({
      cwd: dir,
      toolInput: { file_path: '.mpl/mpl/decomposition.yaml', content: yamlText },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'phase_contract_graph_invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleReviewer: PostToolUse block when reviewer_required: false without rationale', () => {
  const dir = fresh();
  try {
    const yamlText = `phases:
  - id: phase-1
    name: A
    reviewer_required: false
`;
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), yamlText);
    const d = handleReviewer({
      cwd: dir,
      toolInput: { file_path: '.mpl/mpl/decomposition.yaml', content: yamlText },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'reviewer_rationale_missing');
    assert.ok(d.reason.includes('phase-1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleReviewer: allow when rationale present', () => {
  const dir = fresh();
  try {
    const yamlText = `phases:
  - id: phase-1
    name: A
    reviewer_required: false
    reviewer_rationale: trivial doc edit
`;
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), yamlText);
    const d = handleReviewer({
      cwd: dir,
      toolInput: { file_path: '.mpl/mpl/decomposition.yaml', content: yamlText },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleTestAgentBrief: block when brief missing for required phase', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `phases:
  - id: phase-1
    name: A
    test_agent_required: true
`,
    );
    const d = handleTestAgentBrief({
      cwd: dir,
      toolName: 'Task',
      toolInput: {
        subagent_type: 'mpl-test-agent',
        prompt: 'Run tests for phase-1',
      },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'test_agent_brief_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleTestAgentBrief: allow when phase opts out', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `phases:
  - id: phase-1
    name: A
    test_agent_required: false
`,
    );
    const d = handleTestAgentBrief({
      cwd: dir,
      toolName: 'Task',
      toolInput: {
        subagent_type: 'mpl-test-agent',
        prompt: 'Run tests for phase-1',
      },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleTestAgentPostRun: block when PASS evidence missing', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `phases:
  - id: phase-1
    name: A
    test_agent_required: true
`,
    );
    const d = handleTestAgentPostRun({
      cwd: dir,
      toolName: 'Task',
      toolInput: {
        subagent_type: 'mpl-phase-runner',
        prompt: 'Implement phase-1',
      },
      state: { test_agent_dispatched: {} },
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'missing_or_invalid_test_agent_evidence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleTestAgentPostRun: allow when override entry exists', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `phases:
  - id: phase-1
    name: A
    test_agent_required: true
`,
    );
    mkdirSync(join(dir, '.mpl', 'config'), { recursive: true });
    writeFileSync(
      join(dir, '.mpl', 'config', 'test-agent-override.json'),
      JSON.stringify({ 'phase-1': 'manual qa accepted by author' }),
    );
    const d = handleTestAgentPostRun({
      cwd: dir,
      toolName: 'Task',
      toolInput: {
        subagent_type: 'mpl-phase-runner',
        prompt: 'Implement phase-1',
      },
      state: { test_agent_dispatched: {} },
      config: {},
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleE2eGate: block when required scenario never executed on finalize', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'e2e-scenarios.yaml'),
      `scenarios:
  - id: E2E-01
    title: Login
    test_command: npm run e2e:login
    required: true
`,
    );
    const d = handleE2eGate({
      cwd: dir,
      toolName: 'Edit',
      toolInput: {
        file_path: '.mpl/state.json',
        new_string: '{ "finalize_done": true }',
      },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'e2e_scenarios_unresolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleE2eAuthenticity: block on mock_allowed=true when policy forbids', () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'goal-contract.yaml'),
      `project: x
goal: y
content_sha256: abc
acceptance_criteria: []
variation_axes: []
ontology: []
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
`,
    );
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'e2e-scenarios.yaml'),
      `scenarios:
  - id: E2E-01
    title: t
    test_command: npm test
    required: true
    runtime_class: real_web
    mock_allowed: true
`,
    );
    const d = handleE2eAuthenticity({
      cwd: dir,
      toolName: 'Edit',
      toolInput: {
        file_path: '.mpl/state.json',
        new_string: '{ "finalize_done": true }',
      },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'e2e_authenticity_invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleFinalizeArtifacts: block when required artifacts missing', () => {
  const dir = fresh();
  try {
    // No goal contract → blocks with goal_contract_invalid first.
    const d = handleFinalizeArtifacts({
      cwd: dir,
      toolName: 'Edit',
      toolInput: {
        file_path: '.mpl/state.json',
        new_string: '{ "finalize_done": true }',
      },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleWholeGoalClosure: respects config opt-out', () => {
  const dir = fresh();
  try {
    const d = handleWholeGoalClosure({
      cwd: dir,
      toolName: 'Edit',
      toolInput: {
        file_path: '.mpl/state.json',
        new_string: '{ "finalize_done": true }',
      },
      state: {},
      config: { whole_goal_closure_required: false },
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handle() top-level: finalize_done write fans out across 4-rule cluster, first block wins', async () => {
  const dir = fresh();
  try {
    // No goal contract → finalize_artifacts handler blocks first.
    const d = await handle('PreToolUse', {
      cwd: dir,
      toolName: 'Edit',
      toolInput: {
        file_path: '.mpl/state.json',
        new_string: '{ "finalize_done": true }',
      },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handle() top-level: decomposition.yaml write routes to PreToolUse cluster', async () => {
  const dir = fresh();
  try {
    const yamlText = `phases:
  - id: phase-1
    name: A
    covers: []
`;
    const d = await handle('PreToolUse', {
      cwd: dir,
      toolName: 'Write',
      toolInput: { file_path: '.mpl/mpl/decomposition.yaml', content: yamlText },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    // Covers rule fires first in declared order.
    assert.equal(d.code, 'covers_schema_violation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handle() top-level: Task on mpl-seed-generator routes to chain_assignment', async () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'config.json'),
      JSON.stringify({ chain_seed: { enabled: true } }),
    );
    const d = await handle('PreToolUse', {
      cwd: dir,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-seed-generator' },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'chain_assignment_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handle() top-level: PostToolUse mpl-phase-runner Task routes to test_agent_postrun', async () => {
  const dir = fresh();
  try {
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `phases:
  - id: phase-1
    name: A
    test_agent_required: true
`,
    );
    const d = await handle('PostToolUse', {
      cwd: dir,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-phase-runner', prompt: 'phase-1 done' },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'missing_or_invalid_test_agent_evidence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handle() top-level: phase completion via state.json delegates to evidence.verifyPhase', async () => {
  const dir = fresh();
  try {
    // Phase declares command + test_agent. State will complete the phase
    // without recording structural evidence — must block.
    writeFileSync(
      join(dir, '.mpl', 'mpl', 'decomposition.yaml'),
      `phases:
  - id: phase-1
    name: A
    evidence_required: [command, test_agent]
`,
    );
    const proposed = {
      execution: {
        phase_details: [{ id: 'phase-1', status: 'completed' }],
      },
    };
    const d = await handle('PreToolUse', {
      cwd: dir,
      toolName: 'Write',
      toolInput: { file_path: '.mpl/state.json', content: JSON.stringify(proposed) },
      state: { execution: { phase_details: [] } },
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'phase_evidence_latch_missing');
    assert.ok(d.reason.includes('phase-1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handle(): unrelated tool calls pass through', async () => {
  const dir = fresh();
  try {
    const d = await handle('PreToolUse', {
      cwd: dir,
      toolName: 'Read',
      toolInput: { file_path: '/etc/hosts' },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
