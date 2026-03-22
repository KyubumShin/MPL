/**
 * mpl-qmd-verifier.mjs
 *
 * QMD Search-then-Verify module
 *
 * Cross-validates QMD semantic search results with Grep,
 * and caches verified {query → grep pattern} mappings.
 *
 * Compliant with MPL Principle 3: final evidence is always grep-based
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CACHE_FILE = 'qmd-verified-patterns.jsonl';
const DEFAULT_TTL_HOURS = 168; // 7 days

/**
 * Determine the cache file path
 * @param {string} workDir - Project root (git worktree root)
 * @returns {string} Absolute path to cache file
 */
export function getCachePath(workDir) {
  return join(workDir, '.mpl', 'cache', CACHE_FILE);
}

/**
 * Look up an existing pattern in the cache
 * @param {string} workDir
 * @param {string} query - QMD search query
 * @returns {object|null} Cache entry or null
 */
export function findCachedPattern(workDir, query) {
  const cachePath = getCachePath(workDir);
  if (!existsSync(cachePath)) return null;

  const lines = readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
  const normalizedQuery = query.trim().toLowerCase();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.query.trim().toLowerCase() === normalizedQuery) {
        return entry;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

/**
 * Check whether a cache entry is expired
 * @param {object} entry - Cache entry
 * @returns {boolean} true if expired
 */
export function isExpired(entry) {
  if (!entry.verified_at) return true;
  const ttlMs = (entry.cache_ttl_hours || DEFAULT_TTL_HOURS) * 60 * 60 * 1000;
  const age = Date.now() - new Date(entry.verified_at).getTime();
  return age > ttlMs;
}

/**
 * Save a verified pattern to the cache
 * @param {string} workDir
 * @param {object} result - Verification result
 * @param {string} result.query - QMD search query
 * @param {string} result.grep_pattern - Grep pattern used for cross-validation
 * @param {string[]} result.verified_files - List of files that passed verification
 * @param {number} result.qmd_score - QMD relevance score (0-1)
 */
export function saveToCache(workDir, result) {
  const cachePath = getCachePath(workDir);
  const cacheDir = dirname(cachePath);

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const entry = {
    query: result.query,
    grep_pattern: result.grep_pattern,
    verified_files: result.verified_files,
    verified_at: new Date().toISOString(),
    qmd_score: result.qmd_score || null,
    cache_ttl_hours: DEFAULT_TTL_HOURS,
  };

  // Remove existing entry for the same query, then add new entry
  let lines = [];
  if (existsSync(cachePath)) {
    lines = readFileSync(cachePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .filter(line => {
        try {
          const e = JSON.parse(line);
          return e.query.trim().toLowerCase() !== result.query.trim().toLowerCase();
        } catch {
          return false;
        }
      });
  }

  lines.push(JSON.stringify(entry));
  writeFileSync(cachePath, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Cache invalidation based on git diff
 * Removes entries whose verified_files overlap with changed files
 * @param {string} workDir
 * @param {string[]} changedFiles - List of changed files detected via git diff
 * @returns {number} Number of removed entries
 */
export function invalidateByGitDiff(workDir, changedFiles) {
  const cachePath = getCachePath(workDir);
  if (!existsSync(cachePath)) return 0;

  const changedSet = new Set(changedFiles.map(f => f.toLowerCase()));
  const lines = readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
  let removed = 0;

  const surviving = lines.filter(line => {
    try {
      const entry = JSON.parse(line);
      const overlap = (entry.verified_files || []).some(f =>
        changedSet.has(f.toLowerCase())
      );
      if (overlap) {
        removed++;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  });

  if (removed > 0) {
    writeFileSync(cachePath, surviving.join('\n') + (surviving.length ? '\n' : ''), 'utf-8');
  }
  return removed;
}

/**
 * Remove expired entries
 * @param {string} workDir
 * @returns {number} Number of removed entries
 */
export function pruneExpired(workDir) {
  const cachePath = getCachePath(workDir);
  if (!existsSync(cachePath)) return 0;

  const lines = readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
  let removed = 0;

  const surviving = lines.filter(line => {
    try {
      const entry = JSON.parse(line);
      if (isExpired(entry)) {
        removed++;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  });

  if (removed > 0) {
    writeFileSync(cachePath, surviving.join('\n') + (surviving.length ? '\n' : ''), 'utf-8');
  }
  return removed;
}

/**
 * Full Search-then-Verify flow (guide for the Scout agent)
 *
 * Actual QMD/Grep calls are performed by the Scout agent;
 * this function reconciles and saves Scout results against the cache.
 *
 * @param {string} workDir
 * @param {string} query - Search query
 * @param {object} scoutResult - Result returned by Scout
 * @param {object[]} scoutResult.findings - Array of Scout findings
 * @returns {object} { cached: boolean, verified_count: number, unverified_count: number }
 */
export function processScoutResult(workDir, query, scoutResult) {
  const findings = scoutResult.findings || [];
  const verified = findings.filter(f => f.source === 'qmd_verified');
  const unverified = findings.filter(f => f.source === 'qmd_unverified');

  if (verified.length > 0) {
    // Extract grep pattern from the first verified finding
    const grepPattern = verified[0]?.verification?.pattern || query;
    const verifiedFiles = verified.map(f => f.file).filter(Boolean);

    saveToCache(workDir, {
      query,
      grep_pattern: grepPattern,
      verified_files: verifiedFiles,
      qmd_score: verified[0]?.verification?.qmd_score || null,
    });
  }

  return {
    cached: verified.length > 0,
    verified_count: verified.length,
    unverified_count: unverified.length,
  };
}
