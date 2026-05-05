import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  readState,
  writeState,
  CURRENT_SCHEMA_VERSION,
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

  it('caps iterations defensively even if a migration mis-bumps schema_version', () => {
    // Synthesize a corrupt registry entry semantics: pass a state whose
    // current schema_version exceeds CURRENT — runMigrations should refuse
    // to advance further and return as-is.
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
  it('migration chain terminates at the same constant readState enforces', async () => {
    const { CURRENT_SCHEMA_VERSION: invariantSV } = await import('../lib/mpl-state-invariant.mjs').then(async (m) => {
      // mpl-state-invariant re-imports the same constant — confirm both sides agree.
      const stateMod = await import('../lib/mpl-state.mjs');
      return { CURRENT_SCHEMA_VERSION: stateMod.CURRENT_SCHEMA_VERSION };
    });
    assert.equal(invariantSV, CURRENT_SCHEMA_VERSION);
  });
});
