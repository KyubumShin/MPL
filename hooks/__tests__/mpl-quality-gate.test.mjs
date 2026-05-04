import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  parseScore,
  decideAction,
  composeHistoryEntry,
  DEFAULT_QUALITY_THRESHOLD,
  DEFAULT_MAX_ADVERSARIAL_RETRIES,
} from '../lib/mpl-quality-gate.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-quality-gate.mjs');

const VALID_PASS = {
  phase: 'phase-3',
  score: 0.85,
  verdict: 'PASS',
  issues: [],
  timestamp: '2026-05-04T17:30:00Z',
};

const VALID_FAIL = {
  phase: 'phase-3',
  score: 0.45,
  verdict: 'FAIL',
  issues: ['scope leak: src/utils.ts'],
  timestamp: '2026-05-04T17:30:00Z',
};

/* parseScore --------------------------------------------------------------- */

describe('parseScore', () => {
  it('parses a valid object', () => {
    const r = parseScore(VALID_PASS);
    assert.deepStrictEqual(r, VALID_PASS);
  });

  it('parses a valid JSON string', () => {
    const r = parseScore(JSON.stringify(VALID_FAIL));
    assert.deepStrictEqual(r, VALID_FAIL);
  });

  it('rejects null/non-object', () => {
    assert.strictEqual(parseScore(null), null);
    assert.strictEqual(parseScore(42), null);
    assert.strictEqual(parseScore('not-json'), null);
  });

  it('rejects when required field missing', () => {
    assert.strictEqual(parseScore({ ...VALID_PASS, phase: undefined }), null);
    assert.strictEqual(parseScore({ ...VALID_PASS, score: 'high' }), null);
    assert.strictEqual(parseScore({ ...VALID_PASS, verdict: 'maybe' }), null);
    assert.strictEqual(parseScore({ ...VALID_PASS, timestamp: undefined }), null);
  });

  it('rejects non-finite score (NaN, Infinity)', () => {
    assert.strictEqual(parseScore({ ...VALID_PASS, score: NaN }), null);
    assert.strictEqual(parseScore({ ...VALID_PASS, score: Infinity }), null);
  });

  it('coerces issues[] safely (filters non-strings)', () => {
    const r = parseScore({ ...VALID_PASS, issues: ['ok', 42, null, 'also-ok'] });
    assert.deepStrictEqual(r.issues, ['ok', 'also-ok']);
  });

  it('treats missing issues[] as []', () => {
    const r = parseScore({ ...VALID_PASS, issues: undefined });
    assert.deepStrictEqual(r.issues, []);
  });
});

/* decideAction ------------------------------------------------------------- */

describe('decideAction', () => {
  it('PASS verdict + score >= threshold → pass', () => {
    const r = decideAction({ score: 0.85, verdict: 'PASS' });
    assert.strictEqual(r.action, 'pass');
    assert.strictEqual(r.threshold, DEFAULT_QUALITY_THRESHOLD);
    assert.match(r.reason, /Adversarial review PASS/);
  });

  it('FAIL verdict (even with high score) → retry', () => {
    const r = decideAction({ score: 0.95, verdict: 'FAIL' });
    assert.strictEqual(r.action, 'retry');
  });

  it('PASS verdict but score < threshold → retry', () => {
    const r = decideAction({ score: 0.5, verdict: 'PASS' });
    assert.strictEqual(r.action, 'retry');
  });

  it('escalates after max retries', () => {
    const r = decideAction({ score: 0.4, verdict: 'FAIL' }, { retryCount: 3 });
    assert.strictEqual(r.action, 'escalate');
    assert.match(r.reason, /after 3 retries/);
  });

  it('retries up to max', () => {
    const r1 = decideAction({ score: 0.4, verdict: 'FAIL' }, { retryCount: 0 });
    assert.strictEqual(r1.action, 'retry');
    assert.match(r1.reason, /Retry 1\/3/);
    const r2 = decideAction({ score: 0.4, verdict: 'FAIL' }, { retryCount: 2 });
    assert.strictEqual(r2.action, 'retry');
    assert.match(r2.reason, /Retry 3\/3/);
  });

  it('honours custom threshold', () => {
    // 0.75 < 0.9 → retry under stricter threshold
    const r = decideAction({ score: 0.75, verdict: 'PASS' }, { threshold: 0.9 });
    assert.strictEqual(r.action, 'retry');
  });

  it('honours custom maxRetries', () => {
    const r = decideAction({ score: 0.4, verdict: 'FAIL' }, { retryCount: 1, maxRetries: 1 });
    assert.strictEqual(r.action, 'escalate');
  });

  it('singular wording for retryCount=1 in escalate reason', () => {
    const r = decideAction({ score: 0.3, verdict: 'FAIL' }, { retryCount: 1, maxRetries: 1 });
    assert.match(r.reason, /after 1 retry\b/);
  });
});

/* composeHistoryEntry ------------------------------------------------------ */

describe('composeHistoryEntry', () => {
  it('produces a flat record for state.quality_score_history', () => {
    const decision = decideAction(VALID_PASS, { retryCount: 0 });
    const entry = composeHistoryEntry(VALID_PASS, decision);
    assert.strictEqual(entry.phase, VALID_PASS.phase);
    assert.strictEqual(entry.score, VALID_PASS.score);
    assert.strictEqual(entry.verdict, 'PASS');
    assert.strictEqual(entry.action, 'pass');
    assert.strictEqual(entry.retry_count, 0);
    assert.deepStrictEqual(entry.issues, []);
    assert.strictEqual(entry.timestamp, VALID_PASS.timestamp);
  });

  it('captures retry count for retry action', () => {
    const decision = decideAction(VALID_FAIL, { retryCount: 2 });
    const entry = composeHistoryEntry(VALID_FAIL, decision);
    assert.strictEqual(entry.action, 'retry');
    assert.strictEqual(entry.retry_count, 2);
  });
});

/* hook integration --------------------------------------------------------- */

describe('mpl-quality-gate hook integration', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mpl-qg-'));
    mkdirSync(join(tmp, '.mpl', 'signals'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({ current_phase: 'phase2-sprint' }));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function writeScore(obj) {
    writeFileSync(join(tmp, '.mpl', 'signals', 'quality-score.json'), JSON.stringify(obj));
  }

  function readState() {
    return JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
  }

  function runHook(toolName, toolInput, extraState) {
    if (extraState) {
      const cur = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({ ...cur, ...extraState }));
    }
    const stdin = JSON.stringify({
      cwd: tmp,
      tool_name: toolName,
      tool_input: toolInput,
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    return JSON.parse(out);
  }

  it('non-Task tool → silent', () => {
    const r = runHook('Bash', { command: 'ls' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('Task with non-adversarial subagent → silent', () => {
    const r = runHook('Task', { subagent_type: 'mpl-test-agent', prompt: 'x' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('adversarial Task with no score file → silent (reviewer wrote nothing)', () => {
    const r = runHook('Task', { subagent_type: 'mpl-adversarial-reviewer', prompt: 'audit' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('adversarial Task with malformed score → systemMessage, no state mutation', () => {
    writeFileSync(join(tmp, '.mpl', 'signals', 'quality-score.json'), 'not-json');
    const r = runHook('Task', { subagent_type: 'mpl-adversarial-reviewer', prompt: 'audit' });
    assert.match(r.systemMessage, /malformed/);
    assert.strictEqual(readState().adversarial_retry_count, undefined);
  });

  it('PASS verdict → systemMessage, retry counter reset, history appended', () => {
    writeScore(VALID_PASS);
    const r = runHook('Task', { subagent_type: 'mpl-adversarial-reviewer', prompt: 'audit' },
      { adversarial_retry_count: 2 });
    assert.match(r.systemMessage, /Adversarial review PASS/);
    const s = readState();
    assert.strictEqual(s.adversarial_retry_count, 0);
    assert.strictEqual(s.quality_score_history.length, 1);
    assert.strictEqual(s.quality_score_history[0].action, 'pass');
  });

  it('FAIL retry → counter increments, history captures retry', () => {
    writeScore(VALID_FAIL);
    const r = runHook('Task', { subagent_type: 'mpl-adversarial-reviewer', prompt: 'audit' });
    assert.match(r.systemMessage, /Retry 1\/3/);
    const s = readState();
    assert.strictEqual(s.adversarial_retry_count, 1);
    assert.strictEqual(s.quality_score_history[0].action, 'retry');
  });

  it('FAIL at retry budget exhaustion → escalate, counter freezes', () => {
    writeScore(VALID_FAIL);
    const r = runHook('Task', { subagent_type: 'mpl-adversarial-reviewer', prompt: 'audit' },
      { adversarial_retry_count: 3 });
    assert.match(r.systemMessage, /after 3 retries/);
    assert.match(r.systemMessage, /Surface to the user/);
    const s = readState();
    assert.strictEqual(s.adversarial_retry_count, 3); // frozen
    assert.strictEqual(s.quality_score_history[0].action, 'escalate');
  });

  it('workspace config tunes threshold and max_retries', () => {
    writeFileSync(
      join(tmp, '.mpl', 'config.json'),
      JSON.stringify({ adversarial: { threshold: 0.95, max_retries: 1 } }),
    );
    // score 0.85 PASS would normally pass the default 0.7 threshold; here it
    // must fall short of 0.95.
    writeScore({ ...VALID_PASS, score: 0.85 });
    const r = runHook('Task', { subagent_type: 'mpl-adversarial-reviewer', prompt: 'x' });
    assert.match(r.systemMessage, /Retry 1\/1/);
    // After one retry, max_retries=1 means escalate on next failure.
    writeScore({ ...VALID_FAIL });
    const r2 = runHook('Task', { subagent_type: 'mpl-adversarial-reviewer', prompt: 'x' });
    assert.match(r2.systemMessage, /after 1 retry/);
  });

  it('MPL inactive → silent', () => {
    rmSync(join(tmp, '.mpl'), { recursive: true });
    const r = runHook('Task', { subagent_type: 'mpl-adversarial-reviewer', prompt: 'x' });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });
});
