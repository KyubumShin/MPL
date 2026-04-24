/**
 * MPL Session Cache — cross-project Agent SDK session reuse for prompt caching.
 *
 * The Claude Agent SDK's prompt cache activates when a `sessionId` is passed
 * across `query()` calls, so preserving that id across MCP server restarts
 * (and across unrelated projects running in the same server process) is the
 * only way to keep the per-call opus cost bounded. This module persists the
 * id to `~/.mpl/cache/sessions.json`, keyed by project path + tool kind.
 *
 * Each entry is validated on lookup against three dimensions:
 *   - pipeline_id:   fresh pipeline → fresh session
 *   - content_hash:  input context changed (pivot_points edited) → fresh session
 *   - last_used_at:  TTL expired → fresh session
 *
 * TTL precedence (highest wins):
 *   1. explicit `ttl_ms` on the lookup input (test overrides only)
 *   2. per-project `.mpl/config.json` → `session_cache.ttl_minutes`
 *   3. global `~/.mpl/cache/sessions.json` → `config.ttl_minutes`
 *   4. DEFAULT_TTL_MINUTES (30)
 *
 * A fresh session is signalled by returning `null` from `lookupSession`; the
 * caller then issues a query without `sessionId` and calls `persistSession`
 * with the newly-issued id.
 */

import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Resolve HOME-relative paths on each call (not at import time) so tests that
// swap `process.env.HOME` between cases see the new location. Production
// callers pay a trivial `homedir()` lookup per cache read/write — negligible.
function cacheDir(): string {
  return join(homedir(), '.mpl', 'cache');
}
function cacheFile(): string {
  return join(cacheDir(), 'sessions.json');
}
const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MINUTES = 30;
const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days — hard ceiling

export interface SessionEntry {
  session_id: string;
  pipeline_id: string;
  content_hash: string;
  created_at: string;
  last_used_at: string;
  turn_count: number;
}

export interface CacheFile {
  version: number;
  config: { ttl_minutes: number };
  sessions: Record<string, Record<string, SessionEntry>>;
}

function emptyCache(): CacheFile {
  return {
    version: SCHEMA_VERSION,
    config: { ttl_minutes: DEFAULT_TTL_MINUTES },
    sessions: {},
  };
}

function loadCache(): CacheFile {
  if (!existsSync(cacheFile())) return emptyCache();
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), 'utf-8')) as CacheFile;
    if (parsed?.version !== SCHEMA_VERSION) return emptyCache();
    if (!parsed.sessions || typeof parsed.sessions !== 'object') return emptyCache();
    if (!parsed.config || typeof parsed.config.ttl_minutes !== 'number') {
      parsed.config = { ttl_minutes: DEFAULT_TTL_MINUTES };
    }
    return parsed;
  } catch {
    return emptyCache();
  }
}

/**
 * Read `session_cache.ttl_minutes` from the project's `.mpl/config.json`, if
 * present. Returns `null` when the file is absent, unreadable, missing the
 * key, or holds a non-positive/NaN value — callers then fall back to the
 * global cache config or DEFAULT_TTL_MINUTES.
 *
 * Scope: per-project override only. The global cache file's `config.ttl_minutes`
 * is still honored for projects without a per-project override, so existing
 * installs without `session_cache` in their config see no behavior change.
 */
export function readProjectTtlMinutes(cwd: string): number | null {
  try {
    const configPath = join(cwd, '.mpl', 'config.json');
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      session_cache?: { ttl_minutes?: unknown };
    };
    const raw = parsed?.session_cache?.ttl_minutes;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return raw;
  } catch {
    return null;
  }
}

function persistCache(cache: CacheFile): void {
  if (!existsSync(cacheDir())) mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
  // Atomic write via temp + rename to avoid partial files on concurrent access.
  const tmpPath = join(cacheDir(), `.sessions-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
  renameSync(tmpPath, cacheFile());
}

/**
 * Normalize text for content-hash computation. Trimming and CRLF → LF
 * normalization absorb whitespace noise introduced by editors, so minor
 * reformatting of pivot-points.md does not invalidate an otherwise-valid
 * session.
 */
export function normalizeForHash(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/**
 * SHA-256 of normalized content. Designed for prompt-input identity, not
 * security; collisions are effectively impossible in this use case.
 */
export function computeContentHash(text: string): string {
  return createHash('sha256').update(normalizeForHash(text)).digest('hex');
}

export interface LookupInput {
  cwd: string;
  kind: string;
  pipeline_id: string;
  content_hash: string;
  /** Override the configured TTL (rare — prefer configuring via cache file). */
  ttl_ms?: number;
}

/**
 * Return a cached session id when every validation dimension agrees, else
 * `null`. Callers treat `null` as "start a fresh session" and must call
 * `persistSession` once the SDK returns a new id.
 */
export function lookupSession(input: LookupInput): string | null {
  const cache = loadCache();
  const entry = cache.sessions[input.cwd]?.[input.kind];
  if (!entry) return null;
  if (entry.pipeline_id !== input.pipeline_id) return null;
  if (entry.content_hash !== input.content_hash) return null;
  const projectMinutes = readProjectTtlMinutes(input.cwd);
  const effectiveMinutes = projectMinutes ?? cache.config.ttl_minutes;
  const ttlMs = input.ttl_ms ?? effectiveMinutes * 60_000;
  const lastUsed = Date.parse(entry.last_used_at);
  if (!Number.isFinite(lastUsed)) return null;
  if (Date.now() - lastUsed > ttlMs) return null;
  return entry.session_id;
}

export interface PersistInput {
  cwd: string;
  kind: string;
  pipeline_id: string;
  content_hash: string;
  session_id: string;
}

/**
 * Upsert a session entry. When the incoming id matches the stored one we
 * increment `turn_count` and refresh `last_used_at`; otherwise we create a
 * fresh entry (new session_id, turn_count=1).
 */
export function persistSession(input: PersistInput): void {
  const cache = loadCache();
  const now = new Date().toISOString();
  const existing = cache.sessions[input.cwd]?.[input.kind];
  const sameSession =
    !!existing &&
    existing.session_id === input.session_id &&
    existing.pipeline_id === input.pipeline_id &&
    existing.content_hash === input.content_hash;

  const entry: SessionEntry = {
    session_id: input.session_id,
    pipeline_id: input.pipeline_id,
    content_hash: input.content_hash,
    created_at: sameSession ? existing!.created_at : now,
    last_used_at: now,
    turn_count: sameSession ? existing!.turn_count + 1 : 1,
  };

  if (!cache.sessions[input.cwd]) cache.sessions[input.cwd] = {};
  cache.sessions[input.cwd][input.kind] = entry;
  persistCache(cache);
}

/**
 * Remove a specific entry (e.g. on Anthropic API 404 "session not found").
 */
export function invalidateSession(cwd: string, kind: string): void {
  const cache = loadCache();
  const byKind = cache.sessions[cwd];
  if (!byKind?.[kind]) return;
  delete byKind[kind];
  if (Object.keys(byKind).length === 0) delete cache.sessions[cwd];
  persistCache(cache);
}

/**
 * Drop entries whose `last_used_at` is older than `maxAgeMs`. Returns the
 * number of entries removed. Intended to be called opportunistically (once
 * per MCP server boot) to keep the file bounded.
 */
export function gcExpiredEntries(maxAgeMs: number = GC_MAX_AGE_MS): number {
  const cache = loadCache();
  const now = Date.now();
  let removed = 0;
  for (const cwd of Object.keys(cache.sessions)) {
    const kinds = cache.sessions[cwd];
    for (const kind of Object.keys(kinds)) {
      const lastUsed = Date.parse(kinds[kind].last_used_at);
      if (!Number.isFinite(lastUsed) || now - lastUsed > maxAgeMs) {
        delete kinds[kind];
        removed++;
      }
    }
    if (Object.keys(kinds).length === 0) delete cache.sessions[cwd];
  }
  if (removed > 0) persistCache(cache);
  return removed;
}

// Internal helpers exposed for tests — not part of the public contract.
export const __testing = {
  cacheDir,
  cacheFile,
  SCHEMA_VERSION,
  loadCache,
  persistCache,
};
