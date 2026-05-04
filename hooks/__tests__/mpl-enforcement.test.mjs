import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  getEnforcementPolicy,
  isStrict,
  resolveRuleAction,
} from '../lib/mpl-enforcement.mjs';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-enforcement-'));
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeUserConfig(obj) {
  writeFileSync(join(tmp, '.mpl', 'config.json'), JSON.stringify(obj));
}

describe('getEnforcementPolicy', () => {
  it('returns DEFAULTS when no config and no state', () => {
    const p = getEnforcementPolicy(tmp, null);
    assert.strictEqual(p.strict, false);
    // Per #110 §정책: every rule defaults to 'warn' in v0.18.0 (transitional);
    // exp16 / workspace opt-in raises individual rules to 'block'.
    assert.strictEqual(p.missing_gate_evidence, 'warn');
    assert.strictEqual(p.anti_pattern_match, 'warn');
    assert.strictEqual(p.bash_timeout_violation, 'warn');
  });

  it('returns DEFAULTS when state is undefined or non-object', () => {
    assert.strictEqual(getEnforcementPolicy(tmp, undefined).strict, false);
    assert.strictEqual(getEnforcementPolicy(tmp, 'not-an-object').strict, false);
    assert.strictEqual(getEnforcementPolicy(tmp, 42).strict, false);
  });

  it('reads workspace .mpl/config.json enforcement section', () => {
    writeUserConfig({ enforcement: { strict: true, anti_pattern_match: 'block' } });
    const p = getEnforcementPolicy(tmp, null);
    assert.strictEqual(p.strict, true);
    assert.strictEqual(p.anti_pattern_match, 'block');
    // Untouched fields fall back to baseline
    assert.strictEqual(p.missing_gate_evidence, 'warn');
  });

  it('state.enforcement overrides config (per-pipeline precedence)', () => {
    writeUserConfig({ enforcement: { strict: false } });
    const p = getEnforcementPolicy(tmp, { enforcement: { strict: true } });
    assert.strictEqual(p.strict, true);
  });

  it('config overrides DEFAULTS but state still wins over config', () => {
    writeUserConfig({ enforcement: { strict: true, bash_timeout_violation: 'block' } });
    // state pulls strict back to false but doesn't touch bash_timeout_violation
    const p = getEnforcementPolicy(tmp, { enforcement: { strict: false } });
    assert.strictEqual(p.strict, false);
    assert.strictEqual(p.bash_timeout_violation, 'block');
  });

  it('state.enforcement that is not an object is ignored', () => {
    const p = getEnforcementPolicy(tmp, { enforcement: 'strict' });
    assert.strictEqual(p.strict, false);
  });

  it('malformed .mpl/config.json falls back to DEFAULTS without throwing', () => {
    writeFileSync(join(tmp, '.mpl', 'config.json'), '{ this is not json');
    const p = getEnforcementPolicy(tmp, null);
    assert.strictEqual(p.strict, false);
    assert.strictEqual(p.missing_gate_evidence, 'warn');
  });
});

describe('isStrict', () => {
  it('false by default', () => {
    assert.strictEqual(isStrict(tmp, null), false);
    assert.strictEqual(isStrict(tmp, {}), false);
  });

  it('true when state.enforcement.strict === true', () => {
    assert.strictEqual(isStrict(tmp, { enforcement: { strict: true } }), true);
  });

  it('true when workspace config sets strict and state silent', () => {
    writeUserConfig({ enforcement: { strict: true } });
    assert.strictEqual(isStrict(tmp, null), true);
    assert.strictEqual(isStrict(tmp, {}), true);
  });

  it('state false beats config true (per-pipeline override)', () => {
    writeUserConfig({ enforcement: { strict: true } });
    assert.strictEqual(isStrict(tmp, { enforcement: { strict: false } }), false);
  });

  it('treats non-boolean strict values as falsy', () => {
    assert.strictEqual(isStrict(tmp, { enforcement: { strict: 'yes' } }), false);
    assert.strictEqual(isStrict(tmp, { enforcement: { strict: 1 } }), false);
  });
});

describe('resolveRuleAction', () => {
  it('returns explicit block regardless of strict (workspace opt-in)', () => {
    // No rule is hard-pinned in DEFAULTS — `block` only when explicitly set.
    writeUserConfig({ enforcement: { strict: false, missing_gate_evidence: 'block' } });
    assert.strictEqual(resolveRuleAction(tmp, null, 'missing_gate_evidence'), 'block');
    assert.strictEqual(
      resolveRuleAction(tmp, { enforcement: { strict: false } }, 'missing_gate_evidence'),
      'block',
    );
  });

  it('warn rule stays warn when strict is off', () => {
    assert.strictEqual(resolveRuleAction(tmp, null, 'anti_pattern_match'), 'warn');
    assert.strictEqual(resolveRuleAction(tmp, null, 'bash_timeout_violation'), 'warn');
  });

  it('warn rule elevates to block when strict is on', () => {
    const state = { enforcement: { strict: true } };
    assert.strictEqual(resolveRuleAction(tmp, state, 'anti_pattern_match'), 'block');
    assert.strictEqual(resolveRuleAction(tmp, state, 'bash_timeout_violation'), 'block');
  });

  it('off rule stays off even under strict (explicit opt-out)', () => {
    writeUserConfig({ enforcement: { strict: true, anti_pattern_match: 'off' } });
    assert.strictEqual(resolveRuleAction(tmp, null, 'anti_pattern_match'), 'off');
  });

  it('unknown rule treated as warn (default fallback path)', () => {
    // Not in DEFAULTS at all
    assert.strictEqual(resolveRuleAction(tmp, null, 'made_up_rule_id'), 'warn');
    assert.strictEqual(
      resolveRuleAction(tmp, { enforcement: { strict: true } }, 'made_up_rule_id'),
      'block',
    );
  });
});
