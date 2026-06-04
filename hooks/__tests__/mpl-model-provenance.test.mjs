/**
 * exp25 — model provenance stamping (roadmap 01).
 * Reads the resolved model from the transcript tail; stamps it; surfaces a
 * drift-smoke advisory when it changes from the last stamped run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readLastAssistantModel, computeModelProvenance } from '../lib/model-provenance.mjs';

function transcript(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-prov-'));
  const p = join(dir, 't.jsonl');
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const asst = (model) => ({ type: 'assistant', message: { model, content: [] } });
const usr = () => ({ type: 'user', message: { role: 'user', content: 'hi' } });

/* ─────────── readLastAssistantModel ─────────── */

test('returns the LAST assistant message model', () => {
  const p = transcript([asst('claude-opus-4-8'), usr(), asst('claude-sonnet-4-6'), usr()]);
  try { assert.equal(readLastAssistantModel(p), 'claude-sonnet-4-6'); }
  finally { rmSync(join(p, '..'), { recursive: true, force: true }); }
});

test('skips user lines, finds the most recent assistant', () => {
  const p = transcript([asst('claude-opus-4-8'), usr(), usr()]);
  try { assert.equal(readLastAssistantModel(p), 'claude-opus-4-8'); }
  finally { rmSync(join(p, '..'), { recursive: true, force: true }); }
});

test('missing / null path → null (fail-safe)', () => {
  assert.equal(readLastAssistantModel('/no/such/file.jsonl'), null);
  assert.equal(readLastAssistantModel(null), null);
  assert.equal(readLastAssistantModel(''), null);
});

test('a truncated first line in the tail window is skipped, not thrown', () => {
  const p = transcript([asst('claude-opus-4-8')]);
  try {
    // tiny window forces the first line to be cut mid-JSON
    assert.doesNotThrow(() => readLastAssistantModel(p, 8));
  } finally { rmSync(join(p, '..'), { recursive: true, force: true }); }
});

/* ─────────── computeModelProvenance (pure) ─────────── */

test('first stamp: records baseline, NO advisory', () => {
  const { mutation, advisory } = computeModelProvenance(null, 'claude-opus-4-8', '2026-06-04T00:00:00Z');
  assert.deepEqual(mutation, { model_provenance: { current: 'claude-opus-4-8', previous: null, changed_at: '2026-06-04T00:00:00Z' } });
  assert.equal(advisory, null);
});

test('stable model: no write, no advisory', () => {
  const prev = { current: 'claude-opus-4-8' };
  const r = computeModelProvenance(prev, 'claude-opus-4-8', '2026-06-04T00:00:00Z');
  assert.equal(r.mutation, null);
  assert.equal(r.advisory, null);
});

test('changed model: mutation + drift advisory', () => {
  const prev = { current: 'claude-opus-4-8' };
  const { mutation, advisory } = computeModelProvenance(prev, 'claude-sonnet-4-6', '2026-06-04T00:00:00Z');
  assert.equal(mutation.model_provenance.current, 'claude-sonnet-4-6');
  assert.equal(mutation.model_provenance.previous, 'claude-opus-4-8');
  assert.match(advisory, /changed/);
  assert.match(advisory, /claude-opus-4-8 → claude-sonnet-4-6/);
  assert.match(advisory, /drift smoke/);
});

test('invalid model → no-op', () => {
  assert.deepEqual(computeModelProvenance(null, null, 'x'), { mutation: null, advisory: null });
  assert.deepEqual(computeModelProvenance(null, '', 'x'), { mutation: null, advisory: null });
});
