import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Redirect HOME before importing the cache module so that its top-level
// CACHE_DIR constant binds to the test temp directory. This avoids polluting
// the developer's real ~/.mpl/cache/sessions.json during test runs.
const ORIGINAL_HOME = process.env.HOME;
let TEST_HOME;

beforeEach(() => {
  TEST_HOME = mkdtempSync(join(tmpdir(), 'mpl-session-cache-test-'));
  process.env.HOME = TEST_HOME;
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

// Import after HOME is first set in the describe-level hook; Node test
// runner executes hooks before each `it`, so a fresh module is loaded per
// test via dynamic import with a cache-busting query string.
async function loadModule() {
  const url = new URL(`../dist/lib/session-cache.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

describe('session-cache', () => {
  describe('normalizeForHash', () => {
    it('strips CRLF → LF and surrounding whitespace', async () => {
      const mod = await loadModule();
      assert.strictEqual(mod.normalizeForHash('  hello\r\nworld  \n'), 'hello\nworld');
    });

    it('handles bare CR line endings', async () => {
      const mod = await loadModule();
      assert.strictEqual(mod.normalizeForHash('a\rb\rc'), 'a\nb\nc');
    });
  });

  describe('computeContentHash', () => {
    it('produces identical hash for whitespace-equivalent inputs', async () => {
      const mod = await loadModule();
      const h1 = mod.computeContentHash('pivot\n  body\n');
      const h2 = mod.computeContentHash('pivot\r\n  body\r\n  ');
      assert.strictEqual(h1, h2);
    });

    it('produces different hashes for materially different inputs', async () => {
      const mod = await loadModule();
      const h1 = mod.computeContentHash('pivot A');
      const h2 = mod.computeContentHash('pivot B');
      assert.notStrictEqual(h1, h2);
    });
  });

  describe('lookup + persist round-trip', () => {
    it('returns null on cold cache', async () => {
      const mod = await loadModule();
      const id = mod.lookupSession({
        cwd: '/tmp/x',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
      });
      assert.strictEqual(id, null);
    });

    it('returns persisted id for matching key', async () => {
      const mod = await loadModule();
      mod.persistSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_abc',
      });
      const id = mod.lookupSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
      });
      assert.strictEqual(id, 'sess_abc');
    });

    it('invalidates on pipeline_id mismatch', async () => {
      const mod = await loadModule();
      mod.persistSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_abc',
      });
      const id = mod.lookupSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p2',   // different pipeline
        content_hash: 'h1',
      });
      assert.strictEqual(id, null);
    });

    it('invalidates on content_hash mismatch', async () => {
      const mod = await loadModule();
      mod.persistSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_abc',
      });
      const id = mod.lookupSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h2',  // different context
      });
      assert.strictEqual(id, null);
    });

    it('invalidates on TTL expiry', async () => {
      const mod = await loadModule();
      mod.persistSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_abc',
      });
      // Backdate the entry so the freshness check has something to reject.
      // Testing purely via ttl_ms: 0 is unreliable because Date.now() ===
      // last_used_at yields age = 0 which is not > 0 → falsely passes.
      const path = join(TEST_HOME, '.mpl', 'cache', 'sessions.json');
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      raw.sessions['/tmp/proj'].ambiguity.last_used_at = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(path, JSON.stringify(raw));
      const id = mod.lookupSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        ttl_ms: 5_000,
      });
      assert.strictEqual(id, null);
    });

    it('bumps turn_count on repeat persist with same session_id', async () => {
      const mod = await loadModule();
      for (let i = 0; i < 3; i++) {
        mod.persistSession({
          cwd: '/tmp/proj',
          kind: 'ambiguity',
          pipeline_id: 'p1',
          content_hash: 'h1',
          session_id: 'sess_abc',
        });
      }
      const raw = JSON.parse(readFileSync(join(TEST_HOME, '.mpl', 'cache', 'sessions.json'), 'utf-8'));
      assert.strictEqual(raw.sessions['/tmp/proj'].ambiguity.turn_count, 3);
    });

    it('resets turn_count when session_id changes', async () => {
      const mod = await loadModule();
      mod.persistSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_old',
      });
      mod.persistSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_new',
      });
      const raw = JSON.parse(readFileSync(join(TEST_HOME, '.mpl', 'cache', 'sessions.json'), 'utf-8'));
      assert.strictEqual(raw.sessions['/tmp/proj'].ambiguity.session_id, 'sess_new');
      assert.strictEqual(raw.sessions['/tmp/proj'].ambiguity.turn_count, 1);
    });

    it('segregates entries by (cwd, kind)', async () => {
      const mod = await loadModule();
      mod.persistSession({
        cwd: '/tmp/proj-a',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_A',
      });
      mod.persistSession({
        cwd: '/tmp/proj-b',
        kind: 'ambiguity',
        pipeline_id: 'p2',
        content_hash: 'h2',
        session_id: 'sess_B',
      });
      mod.persistSession({
        cwd: '/tmp/proj-a',
        kind: 'classify_scope',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_C',
      });
      assert.strictEqual(
        mod.lookupSession({ cwd: '/tmp/proj-a', kind: 'ambiguity', pipeline_id: 'p1', content_hash: 'h1' }),
        'sess_A',
      );
      assert.strictEqual(
        mod.lookupSession({ cwd: '/tmp/proj-b', kind: 'ambiguity', pipeline_id: 'p2', content_hash: 'h2' }),
        'sess_B',
      );
      assert.strictEqual(
        mod.lookupSession({ cwd: '/tmp/proj-a', kind: 'classify_scope', pipeline_id: 'p1', content_hash: 'h1' }),
        'sess_C',
      );
    });
  });

  describe('invalidateSession', () => {
    it('removes a specific entry', async () => {
      const mod = await loadModule();
      mod.persistSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_abc',
      });
      mod.invalidateSession('/tmp/proj', 'ambiguity');
      const id = mod.lookupSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
      });
      assert.strictEqual(id, null);
    });

    it('is a no-op when entry absent', async () => {
      const mod = await loadModule();
      assert.doesNotThrow(() => mod.invalidateSession('/tmp/nothing', 'ambiguity'));
    });
  });

  describe('gcExpiredEntries', () => {
    it('removes entries older than maxAgeMs', async () => {
      const mod = await loadModule();
      mod.persistSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_abc',
      });
      // Re-write the cache file with a backdated last_used_at to simulate aging.
      const path = join(TEST_HOME, '.mpl', 'cache', 'sessions.json');
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      raw.sessions['/tmp/proj'].ambiguity.last_used_at = new Date(Date.now() - 10_000).toISOString();
      writeFileSync(path, JSON.stringify(raw));
      const removed = mod.gcExpiredEntries(5_000);
      assert.strictEqual(removed, 1);
      const refreshed = JSON.parse(readFileSync(path, 'utf-8'));
      assert.deepStrictEqual(refreshed.sessions, {});
    });
  });

  describe('cache file resilience', () => {
    it('recovers from corrupt JSON', async () => {
      const mod = await loadModule();
      const cacheDir = join(TEST_HOME, '.mpl', 'cache');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, 'sessions.json'), 'not json{{{');
      const id = mod.lookupSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
      });
      assert.strictEqual(id, null);
      // Next persist should succeed and overwrite the corrupt file.
      mod.persistSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
        session_id: 'sess_abc',
      });
      const parsed = JSON.parse(readFileSync(join(cacheDir, 'sessions.json'), 'utf-8'));
      assert.strictEqual(parsed.version, 1);
    });

    it('discards entries with mismatched schema version', async () => {
      const mod = await loadModule();
      const cacheDir = join(TEST_HOME, '.mpl', 'cache');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, 'sessions.json'),
        JSON.stringify({ version: 99, sessions: { '/tmp/proj': { ambiguity: { session_id: 'stale' } } } }),
      );
      const id = mod.lookupSession({
        cwd: '/tmp/proj',
        kind: 'ambiguity',
        pipeline_id: 'p1',
        content_hash: 'h1',
      });
      assert.strictEqual(id, null);
    });
  });
});
