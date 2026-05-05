import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  readState,
  writeState,
  CURRENT_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  LEGACY_EXECUTION_STATE_PATH,
} from '../lib/mpl-state.mjs';
import { MIGRATIONS, runMigrations } from '../lib/migrations/index.mjs';

/* ──────────────────────────── registry shape ──────────────────────────── */

describe('H8 migration registry', () => {
  it('every entry has the required fields and well-formed (from, to)', () => {
    for (const m of MIGRATIONS) {
      assert.equal(typeof m.from, 'number', 'from must be a number');
      assert.equal(typeof m.to, 'number', 'to must be a number');
      assert.equal(typeof m.description, 'string', 'description must be a string');
      assert.equal(typeof m.migrate, 'function', 'migrate must be a function');
      assert.ok(m.to > m.from, `${m.from} → ${m.to}: to must be greater than from`);
    }
  });

  it('registry is contiguous from v1 up to CURRENT_SCHEMA_VERSION', () => {
    let v = 1;
    for (const m of MIGRATIONS) {
      assert.equal(m.from, v, `chain breaks at ${m.from}; expected ${v}`);
      v = m.to;
    }
    assert.equal(v, CURRENT_SCHEMA_VERSION, 'registry must terminate at CURRENT_SCHEMA_VERSION');
  });

  it('does not register .example. templates', () => {
    // A new author dropping `v3-to-v4.example.mjs` into the directory must not
    // suddenly be the active v3→v4 migration. The registry is hand-maintained
    // in index.mjs precisely so example files cannot back-door their way in.
    for (const m of MIGRATIONS) {
      const desc = (m.description ?? '').toLowerCase();
      assert.ok(!desc.startsWith('example'),
        `MIGRATIONS includes an example template: "${m.description}". Move it to a .example. file or remove from registry.`);
    }
  });
});

/* ──────────────────────────── chain runner ────────────────────────────── */

describe('runMigrations', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-mig-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns input unchanged when state is already at target', () => {
    const state = { current_phase: 'phase2-sprint', schema_version: CURRENT_SCHEMA_VERSION };
    const out = runMigrations(state, tmpDir, CURRENT_SCHEMA_VERSION);
    assert.equal(out.schema_version, CURRENT_SCHEMA_VERSION);
  });

  it('walks v1 → v2 when given an unversioned input', () => {
    const state = { current_phase: 'phase1-plan' }; // schema_version absent → v1
    const out = runMigrations(state, tmpDir, CURRENT_SCHEMA_VERSION);
    assert.equal(out.schema_version, CURRENT_SCHEMA_VERSION);
    assert.ok(out.execution, 'execution subtree must be created by v1→v2');
  });

  it('does not throw on null/undefined state', () => {
    assert.equal(runMigrations(null, tmpDir, CURRENT_SCHEMA_VERSION), null);
    assert.equal(runMigrations(undefined, tmpDir, CURRENT_SCHEMA_VERSION), undefined);
  });

  it('refuses to advance state already past target (early-return, no migration applied)', () => {
    // Names exactly what is being checked. The fromVersion >= target
    // early-return at the top of runMigrations — distinct from the
    // safety cap (`MIGRATIONS.length + 1`) which is harder to exercise
    // without a stub registry and stays as in-code defense.
    const state = { current_phase: 'phase1-plan', schema_version: 999 };
    const out = runMigrations(state, tmpDir, CURRENT_SCHEMA_VERSION);
    assert.equal(out.schema_version, 999, 'state with version above target is returned untouched');
  });
});

/* ────────────────────────── readState fail-closed ─────────────────────── */

describe('readState fail-closed on unsupported schema_version (H8)', () => {
  let tmpDir;
  let originalStderrWrite;
  let stderrCaptured;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-h8-'));
    stderrCaptured = '';
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrCaptured += chunk;
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRawState(body) {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify(body));
  }

  it('returns null when schema_version exceeds CURRENT_SCHEMA_VERSION', () => {
    writeRawState({
      current_phase: 'phase2-sprint',
      schema_version: CURRENT_SCHEMA_VERSION + 1,
    });
    const state = readState(tmpDir);
    assert.equal(state, null);
  });

  it('writes a diagnostic stderr line referencing the migration policy doc', () => {
    writeRawState({
      current_phase: 'phase2-sprint',
      schema_version: CURRENT_SCHEMA_VERSION + 5,
    });
    readState(tmpDir);
    assert.match(stderrCaptured, new RegExp(`schema_version=${CURRENT_SCHEMA_VERSION + 5}`));
    assert.match(stderrCaptured, new RegExp(`MAX=${CURRENT_SCHEMA_VERSION}`));
    assert.match(stderrCaptured, /migration-policy\.md/);
  });

  it('does NOT mutate the on-disk file when refusing a newer version', () => {
    writeRawState({
      current_phase: 'phase2-sprint',
      schema_version: CURRENT_SCHEMA_VERSION + 1,
      sentinel: 'do-not-touch',
    });
    readState(tmpDir);
    const raw = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(raw.schema_version, CURRENT_SCHEMA_VERSION + 1);
    assert.equal(raw.sentinel, 'do-not-touch');
  });

  it('still accepts equal schema_version (no fail-closed at parity)', () => {
    writeRawState({
      current_phase: 'phase2-sprint',
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    const state = readState(tmpDir);
    assert.equal(state.schema_version, CURRENT_SCHEMA_VERSION);
  });

  it('legacy v1 state still migrates (regression — H8 must not regress P2-6)', () => {
    writeRawState({
      pipeline_id: 'mpl-h8-legacy',
      current_phase: 'phase2-sprint',
      // schema_version absent → treated as v1
    });
    const state = readState(tmpDir);
    assert.equal(state.schema_version, CURRENT_SCHEMA_VERSION);
    assert.ok(state.execution);
  });
});

/* ──────────────────── consistency with G3 invariant I8 ────────────────── */

describe('CURRENT_SCHEMA_VERSION is the single source of truth', () => {
  it('mpl-state-invariant re-exports the same constant readState enforces', async () => {
    // Re-export added in PR #132 review fix so the assertion actually
    // crosses module boundaries instead of comparing the constant to
    // itself.
    const invariantMod = await import('../lib/mpl-state-invariant.mjs');
    assert.equal(invariantMod.CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION);
  });
});

/* ─────────────── PR #132 review #1: writeState fail-closed ────────────── */

describe('writeState refuses to overwrite a future-schema state (PR #132)', () => {
  let tmpDir;
  let originalStderrWrite;
  let stderrCaptured;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-write-h8-'));
    stderrCaptured = '';
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrCaptured += chunk;
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRawState(body) {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify(body));
  }

  it('throws UnsupportedSchemaVersionError when on-disk schema_version > CURRENT', () => {
    writeRawState({
      current_phase: 'phase2-sprint',
      schema_version: CURRENT_SCHEMA_VERSION + 1,
      sentinel: 'fresh-writer',
    });
    assert.throws(
      () => writeState(tmpDir, { session_status: 'active' }),
      (err) => err instanceof UnsupportedSchemaVersionError
        && err.version === CURRENT_SCHEMA_VERSION + 1
        && err.supported === CURRENT_SCHEMA_VERSION,
    );
  });

  it('does NOT mutate the on-disk file when refusing the write', () => {
    writeRawState({
      current_phase: 'phase2-sprint',
      schema_version: CURRENT_SCHEMA_VERSION + 2,
      sentinel: 'fresh-writer',
      futureField: { nested: 'data' },
    });
    try {
      writeState(tmpDir, { session_status: 'active' });
    } catch {
      // expected
    }
    const raw = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(raw.schema_version, CURRENT_SCHEMA_VERSION + 2, 'schema_version preserved');
    assert.equal(raw.sentinel, 'fresh-writer', 'sentinel field preserved');
    assert.deepEqual(raw.futureField, { nested: 'data' }, 'unknown future field preserved');
    assert.equal(raw.session_status, undefined, 'patch did NOT land');
  });

  it('emits a stderr diagnostic referencing the migration policy doc', () => {
    writeRawState({
      current_phase: 'phase2-sprint',
      schema_version: CURRENT_SCHEMA_VERSION + 1,
    });
    try { writeState(tmpDir, { session_status: 'active' }); } catch { /* expected */ }
    assert.match(stderrCaptured, /writeState refused/);
    assert.match(stderrCaptured, /migration-policy\.md/);
  });

  it('still writes normally when on-disk schema_version is at parity', () => {
    writeRawState({
      current_phase: 'phase2-sprint',
      schema_version: CURRENT_SCHEMA_VERSION,
      execution: { task: 'baseline', phases: { total: 0, completed: 0, current: null, failed: 0, circuit_breaks: 0 } },
    });
    const merged = writeState(tmpDir, { session_status: 'active' });
    assert.equal(merged.session_status, 'active');
    assert.equal(merged.schema_version, CURRENT_SCHEMA_VERSION);
  });

  it('still writes normally when state file does not exist (fresh init path)', () => {
    const merged = writeState(tmpDir, { current_phase: 'phase1-plan' });
    assert.equal(merged.current_phase, 'phase1-plan');
    assert.equal(merged.schema_version, CURRENT_SCHEMA_VERSION);
  });
});

/* ─────── PR #132 review nit #2: corrupt legacy file raw archival ──────── */

describe('v1→v2 migration archives raw bytes when legacy file is corrupt (PR #132 nit #2)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-corrupt-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('preserves the original bytes in legacy_content_raw when JSON.parse fails', () => {
    // Unversioned state (v1) with a corrupt legacy execution file.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      pipeline_id: 'mpl-corrupt-test',
      current_phase: 'phase2-sprint',
    }));
    mkdirSync(join(tmpDir, '.mpl', 'mpl'), { recursive: true });
    const corruptBytes = '{"task": "broken", "phases":';
    writeFileSync(join(tmpDir, '.mpl', 'mpl', 'state.json'), corruptBytes);

    readState(tmpDir);

    // Source legacy file removed
    assert.equal(existsSync(join(tmpDir, LEGACY_EXECUTION_STATE_PATH)), false);

    // Archive carries the raw bytes verbatim plus a corrupt flag — no
    // longer just `null` legacy_content.
    const archiveDir = join(tmpDir, '.mpl', 'archive');
    const archiveFile = readdirSync(archiveDir).find((f) => f.endsWith('legacy-execution-state.json'));
    assert.ok(archiveFile, 'archive file expected');
    const archive = JSON.parse(readFileSync(join(archiveDir, archiveFile), 'utf-8'));
    assert.equal(archive.legacy_content, null);
    assert.equal(archive.legacy_content_raw, corruptBytes, 'raw bytes preserved verbatim');
    assert.equal(archive.legacy_content_corrupt, true);
  });

  it('does NOT add raw fields when the legacy file is well-formed', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      pipeline_id: 'mpl-good-legacy',
      current_phase: 'phase2-sprint',
    }));
    mkdirSync(join(tmpDir, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'mpl', 'state.json'), JSON.stringify({ task: 'ok' }));

    readState(tmpDir);

    const archiveDir = join(tmpDir, '.mpl', 'archive');
    const archiveFile = readdirSync(archiveDir).find((f) => f.endsWith('legacy-execution-state.json'));
    const archive = JSON.parse(readFileSync(join(archiveDir, archiveFile), 'utf-8'));
    assert.equal(archive.legacy_content.task, 'ok');
    assert.equal(archive.legacy_content_raw, undefined);
    assert.equal(archive.legacy_content_corrupt, undefined);
  });
});
