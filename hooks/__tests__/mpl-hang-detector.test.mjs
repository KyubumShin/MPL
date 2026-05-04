import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectHang,
  formatHangMessage,
  DEFAULT_HANG_THRESHOLD_MS,
} from '../lib/mpl-hang-detector.mjs';

const MIN = 60_000;

describe('detectHang', () => {
  it('returns not-hung when state is null/undefined/non-object', () => {
    assert.strictEqual(detectHang(null, Date.now()).hung, false);
    assert.strictEqual(detectHang(undefined, Date.now()).hung, false);
    assert.strictEqual(detectHang('not-an-object', Date.now()).hung, false);
    assert.strictEqual(detectHang(42, Date.now()).hung, false);
  });

  it('returns not-hung when last_tool_at is missing or wrong type', () => {
    assert.strictEqual(detectHang({}, Date.now()).hung, false);
    assert.strictEqual(detectHang({ last_tool_at: null }, Date.now()).hung, false);
    assert.strictEqual(detectHang({ last_tool_at: 12345 }, Date.now()).hung, false);
    assert.strictEqual(detectHang({ last_tool_at: 'not-a-timestamp' }, Date.now()).hung, false);
  });

  it('returns not-hung when elapsed time is within threshold', () => {
    const t = Date.now();
    const last = new Date(t - 5 * MIN).toISOString();
    const r = detectHang({ last_tool_at: last }, t);
    assert.strictEqual(r.hung, false);
    assert.strictEqual(r.elapsedMs, 5 * MIN);
    assert.strictEqual(r.thresholdMs, DEFAULT_HANG_THRESHOLD_MS);
  });

  it('flags hang exactly past threshold (default 15min)', () => {
    const t = Date.now();
    const last = new Date(t - 16 * MIN).toISOString();
    const r = detectHang({ last_tool_at: last }, t);
    assert.strictEqual(r.hung, true);
    assert.match(r.reason, /\[MPL G4\] ⚠ Verification appears hung/);
    assert.match(r.reason, /16min ago/);
    assert.match(r.reason, /threshold 15min/);
  });

  it('flag is NOT raised exactly AT threshold (boundary inclusive lower side)', () => {
    const t = Date.now();
    const last = new Date(t - DEFAULT_HANG_THRESHOLD_MS).toISOString();
    const r = detectHang({ last_tool_at: last }, t);
    assert.strictEqual(r.hung, false);
  });

  it('honours custom threshold via opts.thresholdMs', () => {
    const t = Date.now();
    const last = new Date(t - 6 * MIN).toISOString();
    // 6min elapsed > 5min threshold
    assert.strictEqual(detectHang({ last_tool_at: last }, t, { thresholdMs: 5 * MIN }).hung, true);
    // 6min elapsed < 30min threshold
    assert.strictEqual(detectHang({ last_tool_at: last }, t, { thresholdMs: 30 * MIN }).hung, false);
  });

  it('exempt: paused_budget never flags', () => {
    const t = Date.now();
    const last = new Date(t - 60 * MIN).toISOString();
    const r = detectHang({ last_tool_at: last, session_status: 'paused_budget' }, t);
    assert.strictEqual(r.hung, false);
    assert.match(r.reason, /exempt status: paused_budget/);
  });

  it('exempt: paused_checkpoint never flags', () => {
    const t = Date.now();
    const last = new Date(t - 60 * MIN).toISOString();
    const r = detectHang({ last_tool_at: last, session_status: 'paused_checkpoint' }, t);
    assert.strictEqual(r.hung, false);
  });

  it('exempt: verification_hang preserves marker (no re-detection)', () => {
    const t = Date.now();
    const last = new Date(t - 5 * 60 * MIN).toISOString();
    // Even 5h elapsed: already-marked sessions should not be re-marked.
    const r = detectHang({ last_tool_at: last, session_status: 'verification_hang' }, t);
    assert.strictEqual(r.hung, false);
    assert.match(r.reason, /exempt status: verification_hang/);
  });

  it('accepts now as Date object', () => {
    const now = new Date();
    const last = new Date(now.getTime() - 30 * MIN).toISOString();
    const r = detectHang({ last_tool_at: last }, now);
    assert.strictEqual(r.hung, true);
  });

  it('does not flag when last_tool_at is in the future (clock skew)', () => {
    const t = Date.now();
    const last = new Date(t + 60 * MIN).toISOString();
    const r = detectHang({ last_tool_at: last }, t);
    assert.strictEqual(r.hung, false);
    assert.ok(r.elapsedMs < 0);
  });
});

describe('formatHangMessage', () => {
  it('returns empty string when not hung', () => {
    assert.strictEqual(formatHangMessage({ hung: false, reason: 'within threshold' }), '');
  });

  it('returns reason text when hung', () => {
    const text = '[MPL G4] ⚠ Verification appears hung. ...';
    assert.strictEqual(formatHangMessage({ hung: true, reason: text }), text);
  });
});
