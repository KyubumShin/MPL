import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadConfig } from '../lib/mpl-config.mjs';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-config-'));
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeUserConfig(obj) {
  writeFileSync(join(tmp, '.mpl', 'config.json'), JSON.stringify(obj));
}

describe('loadConfig parallelism', () => {
  it('defaults phase workers to 2', () => {
    assert.strictEqual(loadConfig(tmp).parallelism.max_phase_workers, 2);
  });

  it('honors configured phase workers up to 3', () => {
    writeUserConfig({ parallelism: { max_phase_workers: 3 } });
    assert.strictEqual(loadConfig(tmp).parallelism.max_phase_workers, 3);
  });

  it('clamps excessive phase workers to 3', () => {
    writeUserConfig({ parallelism: { max_phase_workers: 9 } });
    assert.strictEqual(loadConfig(tmp).parallelism.max_phase_workers, 3);
  });

  it('clamps phase workers below 1 to 1', () => {
    writeUserConfig({ parallelism: { max_phase_workers: 0 } });
    assert.strictEqual(loadConfig(tmp).parallelism.max_phase_workers, 1);
  });

  it('falls back to default for non-integer phase workers', () => {
    writeUserConfig({ parallelism: { max_phase_workers: '3' } });
    assert.strictEqual(loadConfig(tmp).parallelism.max_phase_workers, 2);
  });
});
