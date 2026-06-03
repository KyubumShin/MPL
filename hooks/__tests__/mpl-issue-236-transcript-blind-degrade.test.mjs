/**
 * exp24 R1 / G1 + G5 — transcript-blind writer-identity degrade (OPT-IN).
 *
 * The #236 A1 decomposer writer-identity gate is transcript-based. Hosts that
 * never propagate transcript_path (cmux split, headless/CI) leave MPL unable to
 * verify the writer, so the hard block stalls a legitimate dispatched
 * mpl-decomposer (exp24b wrote decomposition to docs/ instead). Because a
 * legit decomposer and a malicious direct write are indistinguishable in a
 * transcript-blind host, the block->warn degrade is OPT-IN and DEFAULT OFF:
 *   - default (no knob)                     -> block (full #236 strength)
 *   - knob true + transcript-blind          -> warn (operator accepted reduced enforcement)
 *   - transcript present (not blind)        -> block regardless of knob
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function freshWorkspace(extraConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-i236-blind-'));
  mkdirSync(join(dir, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(join(dir, '.mpl', 'state.json'), JSON.stringify({ current_phase: 'mpl-decompose' }));
  if (extraConfig) writeFileSync(join(dir, '.mpl', 'config.json'), JSON.stringify(extraConfig));
  return dir;
}

const decompWrite = (cwd, { callerTranscriptPath = null, state = { current_phase: 'mpl-decompose' } } = {}) => ({
  event: 'PreToolUse',
  toolName: 'Write',
  toolInput: { file_path: join(cwd, '.mpl', 'mpl', 'decomposition.yaml'), content: 'phases: []\n' },
  cwd,
  state,
  data: {},
  isMplActive: true,
  callerTranscriptPath,
});

test('default (no knob) + transcript-blind → BLOCK (full #236)', async () => {
  const { handle } = await import('../lib/policy/source-edit.mjs');
  const cwd = freshWorkspace();
  try {
    const r = await handle(decompWrite(cwd));
    assert.equal(r.action, 'block', `expected block, got ${r.action}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('knob ON + transcript-blind → WARN (opt-in degrade)', async () => {
  const { handle } = await import('../lib/policy/source-edit.mjs');
  const cwd = freshWorkspace({ writer_identity_degrade_when_transcript_blind: true });
  try {
    const r = await handle(decompWrite(cwd));
    assert.equal(r.action, 'warn', `expected warn, got ${r.action}: ${r.reason}`);
    assert.match(String(r.reason), /UNVERIFIABLE/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('exp25 regression: knob ON + caller transcript NULL but first_transcript_seen SET → WARN (degrade engages)', async () => {
  // exp25a stalled because the orchestrator Task dispatch recorded
  // first_transcript_seen, and the old condition required it to be unset.
  // The writer (decomposer) still has a null transcript, so it IS blind and
  // must degrade under the opt-in.
  const { handle } = await import('../lib/policy/source-edit.mjs');
  const cwd = freshWorkspace({ writer_identity_degrade_when_transcript_blind: true });
  try {
    const r = await handle(decompWrite(cwd, {
      callerTranscriptPath: null,
      state: { current_phase: 'mpl-decompose', first_transcript_seen: '/tmp/orchestrator.jsonl' },
    }));
    assert.equal(r.action, 'warn', `expected warn (caller transcript null = blind, regardless of first_transcript_seen), got ${r.action}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('knob ON but transcript PRESENT (not blind) + orchestrator recorded → BLOCK', async () => {
  // Capable writer AND the orchestrator DID record a transcript (first_transcript_seen
  // set): arming was possible, so an unarmed write reaching here is suspicious →
  // full #236 strength. This is the boundary that scopes the degrade.
  const { handle } = await import('../lib/policy/source-edit.mjs');
  const cwd = freshWorkspace({ writer_identity_degrade_when_transcript_blind: true });
  try {
    const r = await handle(decompWrite(cwd, {
      callerTranscriptPath: '/tmp/some-transcript.jsonl',
      state: { current_phase: 'mpl-decompose', first_transcript_seen: '/tmp/orchestrator.jsonl' },
    }));
    assert.equal(r.action, 'block', `expected block (transcript present, not a decomposer dispatch), got ${r.action}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('exp25a round-2: knob ON + writer transcript-CAPABLE but orchestrator NEVER recorded (first_transcript_seen null) → WARN', async () => {
  // exp25a's ACTUAL stall. The cmux orchestrator is permanently transcript-blind so
  // it can never arm decomposer_dispatch (arming needs the orchestrator's transcript).
  // The decomposer subagent's Write, however, DOES carry a transcript. Round-1's
  // writer-only condition (!callerTranscriptPath) saw a non-null caller → no degrade
  // → hard block. The fix degrades when arming was IMPOSSIBLE (first_transcript_seen
  // === null), independent of the writer's own transcript.
  const { handle } = await import('../lib/policy/source-edit.mjs');
  const cwd = freshWorkspace({ writer_identity_degrade_when_transcript_blind: true });
  try {
    const r = await handle(decompWrite(cwd, {
      callerTranscriptPath: '/tmp/decomposer-subagent.jsonl', // writer IS transcript-capable
      state: { current_phase: 'mpl-decompose' },              // orchestrator never recorded → null
    }));
    assert.equal(r.action, 'warn', `expected warn (arming impossible: orchestrator blind), got ${r.action}: ${r.reason}`);
    assert.match(String(r.reason), /UNVERIFIABLE/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
