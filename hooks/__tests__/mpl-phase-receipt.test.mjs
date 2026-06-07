/**
 * exp25 R04 (part b) — phase-runner receipt handoff.
 * Pure module (validate/parse/sha/record) + recorder handler (records valid
 * receipts to an audit ledger, advises explicitly on missing/malformed/mismatch).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  validateReceipt, parseReceipt, sha256OfFiles, buildReceiptRecord, VALID_VERDICTS,
} from '../lib/phase-receipt.mjs';
import { handlePhaseReceipt } from '../lib/policy/phase-receipt.mjs';

const SHA = 'a'.repeat(64);

/* ───────────── pure: validateReceipt ───────────── */

test('validateReceipt: well-formed → valid', () => {
  const r = validateReceipt({ phase_id: 'phase-2', verdict: 'PASS', artifacts_sha256: SHA });
  assert.deepEqual(r, { valid: true, errors: [] });
});
test('validateReceipt: bad verdict / missing sha / no phase_id → errors', () => {
  assert.deepEqual(validateReceipt({ phase_id: 'p', verdict: 'OK', artifacts_sha256: SHA }).errors, ['verdict_invalid']);
  assert.deepEqual(validateReceipt({ phase_id: 'p', verdict: 'PASS', artifacts_sha256: 'xyz' }).errors, ['artifacts_sha256_invalid']);
  assert.ok(validateReceipt({ verdict: 'PASS', artifacts_sha256: SHA }).errors.includes('phase_id_missing'));
  assert.deepEqual(validateReceipt(null), { valid: false, errors: ['receipt_absent'] });
});
test('all VALID_VERDICTS accepted', () => {
  for (const v of VALID_VERDICTS) {
    assert.equal(validateReceipt({ phase_id: 'p', verdict: v, artifacts_sha256: SHA }).valid, true);
  }
});

/* ───────────── pure: parseReceipt ───────────── */

test('parseReceipt: extracts receipt from a ```json fenced output', () => {
  const text = 'blah\n```json\n{"status":"complete","receipt":{"phase_id":"phase-3","verdict":"PASS","artifacts_sha256":"' + SHA + '"}}\n```\nmore';
  const r = parseReceipt(text);
  assert.equal(r.phase_id, 'phase-3');
  assert.equal(r.verdict, 'PASS');
});
test('parseReceipt: bare receipt-shaped object', () => {
  const r = parseReceipt('{"verdict":"FAIL","artifacts_sha256":"' + SHA + '","phase_id":"p"}');
  assert.equal(r.verdict, 'FAIL');
});
test('parseReceipt: no receipt → null', () => {
  assert.equal(parseReceipt('just prose, no json'), null);
  assert.equal(parseReceipt('```json\n{"status":"complete"}\n```'), null);
  assert.equal(parseReceipt(''), null);
});

/* ───────────── sha256OfFiles ───────────── */

test('sha256OfFiles: deterministic + sensitive to content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-rcpt-sha-'));
  try {
    writeFileSync(join(dir, 'a.md'), 'hello');
    writeFileSync(join(dir, 'b.md'), 'world');
    const s1 = sha256OfFiles(dir, ['a.md', 'b.md']);
    const s2 = sha256OfFiles(dir, ['a.md', 'b.md']);
    assert.equal(s1, s2);
    assert.match(s1, /^[0-9a-f]{64}$/);
    writeFileSync(join(dir, 'b.md'), 'changed');
    assert.notEqual(sha256OfFiles(dir, ['a.md', 'b.md']), s1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ───────────── handler: record + advise ───────────── */

function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-rcpt-'));
  mkdirSync(join(dir, '.mpl', 'mpl', 'phases', 'phase-2'), { recursive: true });
  return dir;
}
const taskCtx = (cwd, receiptObj) => ({
  toolName: 'Task',
  toolInput: { subagent_type: 'mpl-phase-runner' },
  toolResponse: JSON.stringify({ status: 'complete', receipt: receiptObj }),
  cwd,
  mplActive: true,
});
const ledger = (cwd) => join(cwd, '.mpl', 'mpl', 'receipts.jsonl');

test('handler: valid receipt with matching sha → recorded to ledger, noop', () => {
  const cwd = ws();
  try {
    const a = '.mpl/mpl/phases/phase-2/state-summary.md';
    const b = '.mpl/mpl/phases/phase-2/verification.md';
    writeFileSync(join(cwd, a), '# summary');
    writeFileSync(join(cwd, b), '# verification');
    const sha = sha256OfFiles(cwd, [a, b]);
    const r = handlePhaseReceipt(taskCtx(cwd, { phase_id: 'phase-2', verdict: 'PASS', artifacts_sha256: sha, artifacts: [a, b] }));
    assert.equal(r.action, 'noop');
    assert.ok(existsSync(ledger(cwd)), 'receipts.jsonl should exist');
    const rec = JSON.parse(readFileSync(ledger(cwd), 'utf-8').trim());
    assert.equal(rec.phase_id, 'phase-2');
    assert.equal(rec.verdict, 'PASS');
    assert.equal(rec.sha_verified, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('handler: missing/malformed receipt → explicit advisory (never silent)', () => {
  const cwd = ws();
  try {
    const r = handlePhaseReceipt({
      toolName: 'Task', toolInput: { subagent_type: 'mpl-phase-runner' },
      toolResponse: JSON.stringify({ status: 'complete' }), cwd, mplActive: true,
    });
    assert.equal(r.action, 'advisory');
    assert.match(r.reason, /missing a well-formed receipt/);
    assert.match(r.additionalContext, /verdict/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('handler: sha mismatch → advisory (stale/tampered)', () => {
  const cwd = ws();
  try {
    const a = '.mpl/mpl/phases/phase-2/state-summary.md';
    writeFileSync(join(cwd, a), 'real content');
    const r = handlePhaseReceipt(taskCtx(cwd, { phase_id: 'phase-2', verdict: 'PASS', artifacts_sha256: SHA, artifacts: [a] }));
    assert.equal(r.action, 'advisory');
    assert.match(r.reason, /does NOT match/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('handler: non-phase-runner agent → noop (ignored)', () => {
  const cwd = ws();
  try {
    const r = handlePhaseReceipt({ toolName: 'Task', toolInput: { subagent_type: 'mpl-test-agent' }, toolResponse: '{}', cwd, mplActive: true });
    assert.equal(r.action, 'noop');
    assert.ok(!existsSync(ledger(cwd)));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('handler: mpl inactive / non-task tool → noop', () => {
  assert.equal(handlePhaseReceipt({ toolName: 'Task', toolInput: { subagent_type: 'mpl-phase-runner' }, mplActive: false }).action, 'noop');
  assert.equal(handlePhaseReceipt({ toolName: 'Bash', mplActive: true }).action, 'noop');
});
