import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import {
  detectTauriRustResourceRisk,
  formatBytes,
  parseByteSize,
} from '../lib/mpl-resource-risk.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-resource-risk.mjs');

function writeSizedFile(path, bytes) {
  writeFileSync(path, Buffer.alloc(bytes, 1));
}

describe('resource risk byte parsing', () => {
  it('parses human-readable byte sizes', () => {
    assert.equal(parseByteSize('16GB'), 16 * 1024 ** 3);
    assert.equal(parseByteSize('13.5 GiB'), Math.round(13.5 * 1024 ** 3));
    assert.equal(parseByteSize('705MB'), 705 * 1024 ** 2);
    assert.equal(parseByteSize(42), 42);
    assert.equal(parseByteSize('not-a-size'), null);
  });

  it('formats byte sizes for warnings', () => {
    assert.equal(formatBytes(16 * 1024 ** 3), '16.0 GiB');
    assert.equal(formatBytes(705 * 1024 ** 2), '705.0 MiB');
    assert.equal(formatBytes(512), '512 B');
  });
});

describe('detectTauriRustResourceRisk', () => {
  it('returns not_applicable for non-Tauri/Rust workspaces', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-resource-risk-na-'));
    try {
      const r = detectTauriRustResourceRisk(tmp);
      assert.equal(r.status, 'not_applicable');
      assert.deepEqual(r.warnings, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('warns with measured sizes and recovery recommendations over thresholds', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-resource-risk-warn-'));
    try {
      mkdirSync(join(tmp, 'src-tauri', 'target', 'debug', 'deps'), { recursive: true });
      writeFileSync(join(tmp, 'src-tauri', 'Cargo.toml'), '[package]\nname = "app"\n');
      writeSizedFile(join(tmp, 'src-tauri', 'target', 'debug', 'deps', 'libdep.rlib'), 80);
      writeSizedFile(join(tmp, 'src-tauri', 'target', 'debug', 'libapp.a'), 70);
      writeSizedFile(join(tmp, 'src-tauri', 'target', 'debug', 'other.o'), 10);

      const r = detectTauriRustResourceRisk(tmp, {
        targetWarnBytes: 100,
        depsWarnBytes: 50,
        staticLibWarnBytes: 60,
      });
      assert.equal(r.status, 'warn');
      assert.deepEqual(r.warnings.map((w) => w.id).sort(), [
        'tauri_deps_size_warn',
        'tauri_static_lib_size_warn',
        'tauri_target_size_warn',
      ]);
      assert.ok(r.measurements.find((m) => m.id === 'src_tauri_target' && m.bytes === 160));
      assert.ok(r.measurements.find((m) => m.id === 'src_tauri_target_deps' && m.bytes === 80));
      assert.match(r.warnings.find((w) => w.id === 'tauri_target_size_warn').recommendation, /cargo clean/);
      assert.match(r.warnings.find((w) => w.id === 'tauri_static_lib_size_warn').recommendation, /multi-crate/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('CLI emits deterministic JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-resource-risk-cli-'));
    try {
      mkdirSync(join(tmp, 'src-tauri'), { recursive: true });
      writeFileSync(join(tmp, 'src-tauri', 'Cargo.toml'), '[package]\nname = "app"\n');
      const out = execFileSync('node', [HOOK_PATH, tmp], { encoding: 'utf-8' });
      const r = JSON.parse(out);
      assert.equal(r.kind, 'tauri_rust_resource_risk');
      assert.equal(r.status, 'pass');
      assert.deepEqual(r.warnings, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
