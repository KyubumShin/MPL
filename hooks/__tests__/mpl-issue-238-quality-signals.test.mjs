/**
 * #238 — soft-signal telemetry surface for prompt-only quality rules.
 *
 * Acceptance criteria coverage (from the issue body):
 *   - `.mpl/mpl/quality-signals.jsonl` accumulates entries when target
 *     rules fire.
 *   - Tests cover at least HA-01 prompt detection + ambiguity_notes
 *     presence check.
 *   - No blocking behavior change for any listed rule.
 *
 * Out of scope (deferred to follow-up):
 *   - A4 mpl-validate-output JSON-fence telemetry
 *   - A5 test_command finalize elevation
 *   - A6 probing hints zero-coverage detection
 *   - A8 HA-02 BEGIN/END region mirror
 *   - A9 Retry-2 reflection
 *   - A10 Interviewer comparison table
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  signalsLogPath,
  recordQualitySignal,
  readQualitySignals,
  summarizeQualitySignals,
  detectHa01,
  detectSeedAmbiguityNotesGap,
} from '../lib/mpl-quality-signals.mjs';

const HOOKS_DIR = join(import.meta.dirname, '..');

function freshWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'mpl-238-'));
  mkdirSync(join(cwd, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(
    join(cwd, '.mpl', 'state.json'),
    JSON.stringify({ current_phase: 'phase-1' }),
  );
  return cwd;
}

function runHook(scriptRelPath, payload) {
  const script = join(HOOKS_DIR, scriptRelPath);
  const json = JSON.stringify(payload);
  const out = execSync(`node "${script}"`, {
    input: json,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  }).toString();
  return JSON.parse(out.trim());
}

// ---------------------------------------------------------------------------
// recordQualitySignal — append-only writes + schema fields
// ---------------------------------------------------------------------------

test('#238: recordQualitySignal creates the log file and appends one record per call', () => {
  const cwd = freshWorkspace();
  try {
    const path = signalsLogPath(cwd);
    assert.equal(existsSync(path), false, 'log starts absent');

    assert.equal(
      recordQualitySignal(
        { rule: 'HA-01', agent: 'mpl-decomposer', evidence: { matched_phrase: '알아서 판단' } },
        cwd,
      ),
      true,
    );
    assert.equal(existsSync(path), true);

    recordQualitySignal(
      { rule: 'seed-ambiguity-notes', evidence: { matched: 'TBD' } },
      cwd,
    );

    const { records, malformed } = readQualitySignals(cwd);
    assert.equal(records.length, 2);
    assert.equal(malformed, 0);
    assert.equal(records[0].rule, 'HA-01');
    assert.equal(records[0].severity, 'warn');
    assert.equal(records[0].agent, 'mpl-decomposer');
    assert.equal(records[0].phase, 'phase-1');
    assert.equal(typeof records[0].ts, 'string');
    assert.ok(records[0].ts.includes('T'));
    assert.equal(records[1].rule, 'seed-ambiguity-notes');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#238: recordQualitySignal returns false on missing rule or cwd (fail-soft)', () => {
  assert.equal(recordQualitySignal({}, '/tmp/whatever'), false);
  assert.equal(recordQualitySignal({ rule: 'X' }, ''), false);
});

test('#238: summarizeQualitySignals counts and sorts by descending rule frequency', () => {
  const counts = summarizeQualitySignals([
    { rule: 'HA-01' },
    { rule: 'seed-ambiguity-notes' },
    { rule: 'HA-01' },
    { rule: 'HA-01' },
    { rule: 'seed-ambiguity-notes' },
  ]);
  assert.deepEqual(counts, { 'HA-01': 3, 'seed-ambiguity-notes': 2 });
});

test('#238 codex r1 [contract-break]: readQualitySignals reports malformed-line count (so doctor Category 16 can WARN)', () => {
  // Codex r1: Category 16's "WARN when log has malformed lines"
  // promise required a reader contract that surfaces the malformed
  // count, not silently skips. Test: a log with 2 valid + 1 bad line
  // returns records.length=2 AND malformed=1.
  const cwd = freshWorkspace();
  try {
    const path = signalsLogPath(cwd);
    writeFileSync(
      path,
      '{"rule":"HA-01"}\nnot-json\n{"rule":"seed-ambiguity-notes"}\n',
    );
    const { records, malformed } = readQualitySignals(cwd);
    assert.equal(records.length, 2);
    assert.equal(malformed, 1);
    assert.equal(records[0].rule, 'HA-01');
    assert.equal(records[1].rule, 'seed-ambiguity-notes');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#238 codex r1 [contract-break]: readQualitySignals returns {records:[], malformed:0} for an absent log', () => {
  const cwd = freshWorkspace();
  try {
    const result = readQualitySignals(cwd);
    assert.deepEqual(result, { records: [], malformed: 0 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HA-01 detector
// ---------------------------------------------------------------------------

test('#238 [HA-01]: detects Korean vague-delegation phrases case-insensitively', () => {
  assert.deepEqual(
    detectHa01('Phase 3 작업: 이전 결과 참고해서 마무리해줘.'),
    { phrase: '이전 결과 참고', offset: '"Phase 3 작업: '.length - 1 },
  );
  assert.equal(detectHa01('알아서 판단해주세요')?.phrase, '알아서 판단');
  assert.equal(detectHa01('알아서 처리')?.phrase, '알아서 처리');
  assert.equal(detectHa01('적절히 판단해서')?.phrase, '적절히 판단');
});

test('#238 [HA-01]: detects English vague-delegation phrases', () => {
  assert.equal(detectHa01('Use your judgement here.')?.phrase, 'use your judgement');
  assert.equal(detectHa01('Adapt as appropriate.')?.phrase, 'as appropriate');
  assert.equal(detectHa01('Just figure it out.')?.phrase, 'figure it out');
});

test('#238 [HA-01]: no match returns null', () => {
  assert.equal(detectHa01('Decompose the goal into 3 phases with concrete acceptance criteria.'), null);
  assert.equal(detectHa01(''), null);
  assert.equal(detectHa01(null), null);
});

// ---------------------------------------------------------------------------
// Seed ambiguity-notes gap detector
// ---------------------------------------------------------------------------

test('#238 [seed-ambiguity-notes]: TBD/unclear without ambiguity_notes fires the signal', () => {
  const yaml = `phase_seed:
  goal: "Implement TBD endpoint"
  acceptance_criteria:
    - "returns 200"
`;
  const result = detectSeedAmbiguityNotesGap(yaml);
  assert.ok(result, 'should detect');
  assert.equal(result.reason, 'uncertainty-without-ambiguity-notes');
  assert.equal(result.matched, 'TBD');
});

test('#238 [seed-ambiguity-notes]: Korean uncertainty vocabulary triggers the signal', () => {
  const yaml = `phase_seed:
  goal: "정확한 동작 모르겠음, 추정으로 진행"
  acceptance_criteria:
    - "기본 케이스"
`;
  const result = detectSeedAmbiguityNotesGap(yaml);
  assert.ok(result);
  assert.equal(result.reason, 'uncertainty-without-ambiguity-notes');
});

test('#238 [seed-ambiguity-notes]: presence of ambiguity_notes suppresses the signal', () => {
  const yaml = `phase_seed:
  goal: "Implement TBD endpoint"
  ambiguity_notes:
    - "Boundary unclear: which auth tier applies"
  acceptance_criteria:
    - "returns 200"
`;
  assert.equal(detectSeedAmbiguityNotesGap(yaml), null);
});

test('#238 [seed-ambiguity-notes]: no uncertainty vocabulary → no signal', () => {
  const yaml = `phase_seed:
  goal: "Implement /healthz endpoint"
  acceptance_criteria:
    - "returns 200 OK"
`;
  assert.equal(detectSeedAmbiguityNotesGap(yaml), null);
});

// ---------------------------------------------------------------------------
// End-to-end: mpl-soft-signal-emit hook never blocks + writes record on HA-01
// ---------------------------------------------------------------------------

test('#238 e2e: soft-signal-emit hook writes HA-01 record for vague Task prompt and never blocks', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook('mpl-soft-signal-emit.mjs', {
      cwd,
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'mpl-decomposer',
        prompt: 'Decompose this. 이전 결과 참고해서 알아서 판단.',
      },
    });
    assert.equal(decision.continue, true, 'must never block');
    const { records, malformed } = readQualitySignals(cwd);
    assert.equal(records.length, 1);
    assert.equal(malformed, 0);
    assert.equal(records[0].rule, 'HA-01');
    assert.equal(records[0].agent, 'mpl-decomposer');
    assert.equal(records[0].evidence.matched_phrase, '이전 결과 참고');
    assert.ok(records[0].evidence.prompt_preview.includes('이전 결과 참고'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#238 e2e: soft-signal-emit hook stays silent on a well-scoped prompt', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook('mpl-soft-signal-emit.mjs', {
      cwd,
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'mpl-decomposer',
        prompt: 'Decompose the goal of adding /healthz endpoint into 3 phases with concrete acceptance criteria.',
      },
    });
    assert.equal(decision.continue, true);
    assert.equal(readQualitySignals(cwd).records.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#238 e2e: soft-signal-emit hook is a no-op outside MPL workspaces', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mpl-238-no-mpl-'));
  try {
    const decision = runHook('mpl-soft-signal-emit.mjs', {
      cwd,
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'mpl-decomposer',
        prompt: '이전 결과 참고해서 알아서 판단.',
      },
    });
    assert.equal(decision.continue, true);
    assert.equal(existsSync(signalsLogPath(cwd)), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#238 codex r2 [contract-break] e2e: soft-signal-emit hook accepts camelCase payload shape', () => {
  // Codex r2: sibling hooks normalize both `tool_name` and `toolName`.
  // The new hook initially read only snake_case, silently losing
  // HA-01 signals on a camelCase harness delivery.
  const cwd = freshWorkspace();
  try {
    const decision = runHook('mpl-soft-signal-emit.mjs', {
      cwd,
      toolName: 'Task',
      toolInput: {
        subagent_type: 'mpl-decomposer',
        prompt: 'Decompose this. 이전 결과 참고해서 알아서 판단.',
      },
    });
    assert.equal(decision.continue, true, 'must never block');
    const { records, malformed } = readQualitySignals(cwd);
    assert.equal(records.length, 1, 'HA-01 record must be appended even on camelCase payload');
    assert.equal(malformed, 0);
    assert.equal(records[0].rule, 'HA-01');
    assert.equal(records[0].agent, 'mpl-decomposer');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#238 e2e: soft-signal-emit hook ignores non-Task tools', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runHook('mpl-soft-signal-emit.mjs', {
      cwd,
      tool_name: 'Bash',
      tool_input: { command: '이전 결과 참고' },
    });
    assert.equal(decision.continue, true);
    assert.equal(existsSync(signalsLogPath(cwd)), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
