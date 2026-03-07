/**
 * MPL Phase 0 Cache Utility
 *
 * Provides cache key generation, hit/miss detection, and cache persistence
 * for Phase 0 Enhanced artifacts (api-contracts, examples, type-policy, error-spec).
 *
 * Cache directory: .mpl/cache/phase0/
 * Cache key: SHA-256 hash of test files, directory structure, dependencies, and source files.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

const CACHE_DIR = '.mpl/cache/phase0';
const MANIFEST_FILE = 'manifest.json';
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Generate a SHA-256 cache key from project inputs.
 *
 * @param {object} inputs
 * @param {string[]} inputs.testFiles - Paths to test files
 * @param {string[]} inputs.structureDirs - Directory names from codebase analysis
 * @param {string[]} inputs.externalDeps - External dependency names/versions
 * @param {string[]} inputs.sourceFiles - Paths to public API source files
 * @returns {string} SHA-256 hex digest
 */
export function generateCacheKey({ testFiles = [], structureDirs = [], externalDeps = [], sourceFiles = [] }) {
  const hashContent = (files) => {
    return files
      .filter(f => existsSync(f))
      .sort()
      .map(f => readFileSync(f, 'utf-8'))
      .join('\n---\n');
  };

  const payload = JSON.stringify({
    test_files_hash: createHash('sha256').update(hashContent(testFiles)).digest('hex'),
    structure_hash: createHash('sha256').update(structureDirs.sort().join(',')).digest('hex'),
    deps_hash: createHash('sha256').update(externalDeps.sort().join(',')).digest('hex'),
    source_files_hash: createHash('sha256').update(hashContent(sourceFiles)).digest('hex'),
  });

  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Check if a valid cache exists for the given project root.
 *
 * @param {string} cwd - Project root directory
 * @returns {{ hit: boolean, manifest: object|null, cacheDir: string }}
 */
export function checkCache(cwd) {
  const cacheDir = join(cwd, CACHE_DIR);
  const manifestPath = join(cacheDir, MANIFEST_FILE);

  if (!existsSync(manifestPath)) {
    return { hit: false, manifest: null, cacheDir };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (!manifest.cache_key || !manifest.timestamp || !manifest.artifacts) {
      return { hit: false, manifest: null, cacheDir };
    }

    // TTL check: expire cache after DEFAULT_TTL_MS
    const age = Date.now() - new Date(manifest.timestamp).getTime();
    if (age > DEFAULT_TTL_MS) {
      return { hit: false, manifest: null, cacheDir, reason: 'expired' };
    }

    // Verify all cached artifact files exist
    const allExist = manifest.artifacts.every(name =>
      existsSync(join(cacheDir, name))
    );

    if (!allExist) {
      return { hit: false, manifest: null, cacheDir };
    }

    return { hit: true, manifest, cacheDir };
  } catch {
    return { hit: false, manifest: null, cacheDir };
  }
}

/**
 * Validate cache against a freshly computed cache key.
 *
 * @param {string} cwd - Project root directory
 * @param {string} currentKey - Freshly computed cache key
 * @returns {{ valid: boolean, manifest: object|null, reason: string }}
 */
export function validateCache(cwd, currentKey) {
  const { hit, manifest, cacheDir } = checkCache(cwd);

  if (!hit) {
    return { valid: false, manifest: null, reason: 'no_cache' };
  }

  if (manifest.cache_key !== currentKey) {
    return { valid: false, manifest, reason: 'key_mismatch' };
  }

  return { valid: true, manifest, reason: 'valid' };
}

/**
 * Save Phase 0 artifacts to cache.
 *
 * @param {string} cwd - Project root directory
 * @param {object} options
 * @param {string} options.cacheKey - Cache key to store
 * @param {string} options.complexityGrade - Complexity grade (Simple/Medium/Complex/Enterprise)
 * @param {object} options.artifacts - Map of filename -> content to cache
 * @returns {{ saved: boolean, cacheDir: string, artifactCount: number }}
 */
export function saveCache(cwd, { cacheKey, complexityGrade, artifacts }) {
  const cacheDir = join(cwd, CACHE_DIR);

  try {
    mkdirSync(cacheDir, { recursive: true });

    const artifactNames = Object.keys(artifacts);

    // Write each artifact
    for (const [name, content] of Object.entries(artifacts)) {
      writeFileSync(join(cacheDir, name), content, 'utf-8');
    }

    // Write manifest
    const manifest = {
      cache_key: cacheKey,
      timestamp: new Date().toISOString(),
      complexity_grade: complexityGrade,
      artifacts: artifactNames,
    };
    writeFileSync(join(cacheDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf-8');

    return { saved: true, cacheDir, artifactCount: artifactNames.length };
  } catch {
    return { saved: false, cacheDir, artifactCount: 0 };
  }
}

/**
 * Read a cached artifact by filename.
 *
 * @param {string} cwd - Project root directory
 * @param {string} artifactName - Filename of the cached artifact
 * @returns {string|null} File content or null if not found
 */
export function readCachedArtifact(cwd, artifactName) {
  const filePath = join(cwd, CACHE_DIR, artifactName);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Invalidate (delete) the Phase 0 cache for a project.
 *
 * @param {string} cwd - Project root directory
 * @returns {{ invalidated: boolean, cacheDir: string }}
 */
export function invalidateCache(cwd) {
  const cacheDir = join(cwd, CACHE_DIR);
  if (!existsSync(cacheDir)) {
    return { invalidated: false, cacheDir };
  }
  try {
    rmSync(cacheDir, { recursive: true, force: true });
    return { invalidated: true, cacheDir };
  } catch {
    return { invalidated: false, cacheDir };
  }
}
