/**
 * permit.unknown_bash YAML wire — confirms `mpl.config.yaml#permit.unknown_bash`
 * flows through `loadConfigV2` into `handleAutoPermit` so a workspace can
 * configure the unknown-bash policy via the YAML SSOT instead of only
 * `.mpl/config.json`.
 *
 * Disconnection background (pre-fix):
 *   handleAutoPermit called the legacy `loadConfig(cwd)` which reads
 *   .mpl/config.json ONLY. mpl.config.yaml.permit.unknown_bash was DECLARED
 *   (line 682) but UNREACHABLE — the runtime never consumed it.
 *
 * Fix (this PR): handleAutoPermit + handleBashTimeout now route through
 * `_loadMergedConfig(cwd)` which prefers `loadConfigV2` (YAML SSOT) and
 * falls back to legacy. `.mpl/config.json` still wins via step 1 of
 * `resolveUnknownBashPolicy`'s precedence chain.
 *
 * Assertions:
 *   1. mpl.config.yaml-only `permit.unknown_bash: block-strict` →
 *      `handleAutoPermit` returns action='block' for unknown bash.
 *   2. mpl.config.yaml=`block-strict` + .mpl/config.json=`allow-loose` →
 *      JSON wins (action='approve').
 *   3. mpl.config.yaml=`allow-loose` (no JSON) → action='approve'.
 *   4. No config at all → default pass-through.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { handleAutoPermit, resolveUnknownBashPolicy } from '../lib/policy/permit.mjs';
import { __clearCacheForTesting } from '../lib/config.mjs';

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-permit-yaml-'));
  mkdirSync(join(dir, '.mpl'), { recursive: true });
  // Active MPL state — minimal seed.
  writeFileSync(join(dir, '.mpl', 'state.json'), JSON.stringify({
    schema_version: 7,
    current_phase: 'phase2-sprint',
  }));
  return dir;
}

function writeYaml(dir, contents) {
  writeFileSync(join(dir, 'mpl.config.yaml'), contents);
}

function writeJsonConfig(dir, cfg) {
  writeFileSync(join(dir, '.mpl', 'config.json'), JSON.stringify(cfg));
}

describe('permit.unknown_bash YAML wire (mpl.config.yaml → handleAutoPermit)', () => {
  let tmp;

  beforeEach(() => {
    tmp = freshDir();
    __clearCacheForTesting();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    __clearCacheForTesting();
  });

  it('YAML-only block-strict → unknown bash blocks via handleAutoPermit', () => {
    writeYaml(tmp, [
      'permit:',
      '  unknown_bash: block-strict',
      '',
    ].join('\n'));

    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'mystery-tool --do-thing' },
      isMplActive: true,
    });
    assert.equal(d.action, 'block', `expected block, got: ${JSON.stringify(d)}`);
    assert.match(d.reason || '', /unknown_bash=block-strict/);
  });

  it('YAML allow-loose (no JSON) → unknown bash approves', () => {
    writeYaml(tmp, [
      'permit:',
      '  unknown_bash: allow-loose',
      '',
    ].join('\n'));

    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'mystery-tool --do-thing' },
      isMplActive: true,
    });
    assert.equal(d.action, 'approve', `expected approve, got: ${JSON.stringify(d)}`);
  });

  it('.mpl/config.json takes precedence over YAML (JSON=allow-loose beats YAML=block-strict)', () => {
    writeYaml(tmp, [
      'permit:',
      '  unknown_bash: block-strict',
      '',
    ].join('\n'));
    writeJsonConfig(tmp, { permit: { unknown_bash: 'allow-loose' } });

    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'mystery-tool --do-thing' },
      isMplActive: true,
    });
    assert.equal(d.action, 'approve', `JSON override should win, got: ${JSON.stringify(d)}`);
  });

  it('no config anywhere → default pass-through (eval finding #1c)', () => {
    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'mystery-tool --do-thing' },
      isMplActive: true,
    });
    assert.equal(d.action, 'pass-through');
  });

  it('resolveUnknownBashPolicy reads YAML value directly when called with the v2-merged config', async () => {
    writeYaml(tmp, [
      'permit:',
      '  unknown_bash: block-strict',
      '',
    ].join('\n'));
    const { loadConfigV2 } = await import('../lib/config.mjs');
    const cfg = loadConfigV2(tmp);
    assert.equal(cfg?.permit?.unknown_bash, 'block-strict',
      'loadConfigV2 should expose permit.unknown_bash from mpl.config.yaml');
    assert.equal(resolveUnknownBashPolicy(tmp, cfg), 'block-strict');
  });
});
