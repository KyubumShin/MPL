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
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';

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

    // Write manifest (includes commit_hash — F-05 partial invalidation diff reference point)
    const manifest = {
      cache_key: cacheKey,
      commit_hash: getHeadCommitHash(cwd),
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

// ---------------------------------------------------------------------------
// F-05: Partial Cache Invalidation (git diff-based partial invalidation)
// ---------------------------------------------------------------------------

/** Phase 0 per-step artifact mapping */
const STEP_ARTIFACT_MAP = {
  api_contracts: 'api-contracts.md',
  examples: 'examples.md',
  type_policy: 'type-policy.md',
  error_spec: 'error-spec.md',
};

/**
 * Returns the commit hash of the current HEAD.
 * Returns null if not a git repository or on failure.
 *
 * @param {string} cwd - Working directory
 * @returns {string|null}
 */
function getHeadCommitHash(cwd) {
  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Determines whether a file path is a public API source.
 *
 * @param {string} filePath - Relative path from project root
 * @returns {boolean}
 */
function isPublicApi(filePath) {
  if (isTestFile(filePath)) return false;

  const sourceExts = /\.(ts|js|py|go|rs|java|c|cpp)$/;
  if (!sourceExts.test(filePath)) return false;

  // Source directory patterns (common project layouts)
  const sourceDirPatterns = ['src/', 'lib/', 'app/', 'pkg/', 'packages/', 'core/', 'internal/'];
  const normalized = filePath.replace(/\\/g, '/');

  // File is inside a source directory or is a root-level source file
  return sourceDirPatterns.some(dir => normalized.includes(dir))
    || !normalized.includes('/');  // Root-level (e.g., main.py, index.ts)
}

/**
 * Determines whether a file path is a test file.
 *
 * @param {string} filePath - Relative path from project root
 * @returns {boolean}
 */
function isTestFile(filePath) {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath)
    || /\/test_[^/]+\.py$/.test(filePath)
    || /_test\.(go|rs)$/.test(filePath);
}

/**
 * Determines whether a file path is a type definition file.
 *
 * @param {string} filePath - Relative path from project root
 * @returns {boolean}
 */
function isTypeDefinition(filePath) {
  return /\.d\.ts$/.test(filePath)
    || /\/types\.(ts|py)$/.test(filePath)
    || /\/interfaces\.ts$/.test(filePath)
    || /\/models\.py$/.test(filePath);
}

/**
 * Determines whether a file path is an error handler file.
 * Determined by filename pattern only; content inspection is left to the caller if needed.
 *
 * @param {string} filePath - Relative path from project root
 * @returns {boolean}
 */
function isErrorHandler(filePath) {
  const base = basename(filePath);
  return /^error/i.test(base) || /^exception/i.test(base);
}

/**
 * Analyze partial invalidation based on git diff.
 *
 * Analyzes files changed since the cache manifest's commit_hash (or timestamp)
 * and classifies the affected Phase 0 steps.
 *
 * @param {string} cwd - Working directory
 * @returns {{ scope: 'none'|'partial'|'full', affectedSteps?: string[], unaffectedArtifacts?: string[] }}
 */
export function analyzePartialInvalidation(cwd) {
  const cacheDir = join(cwd, CACHE_DIR);
  const manifestPath = join(cacheDir, MANIFEST_FILE);

  if (!existsSync(manifestPath)) {
    return { scope: 'full' };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { scope: 'full' };
  }

  // Determine diff reference: prefer commit_hash, fall back to timestamp
  const diffRef = manifest.commit_hash || null;
  if (!diffRef) {
    // Legacy cache without commit_hash — safely re-run everything
    return { scope: 'full' };
  }

  // Run git diff
  let changedFiles;
  try {
    const output = execSync(`git diff --name-only ${diffRef} HEAD`, {
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    changedFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    // git diff failed — safe fallback: re-run everything
    return { scope: 'full' };
  }

  if (changedFiles.length === 0) {
    return { scope: 'none' };
  }

  // Classify changed files by Phase 0 step
  const affected = {
    api_contracts: false,
    examples: false,
    type_policy: false,
    error_spec: false,
  };

  for (const file of changedFiles) {
    if (isPublicApi(file)) affected.api_contracts = true;
    if (isTestFile(file)) affected.examples = true;
    if (isTypeDefinition(file)) affected.type_policy = true;
    if (isErrorHandler(file)) affected.error_spec = true;
  }

  const affectedSteps = Object.entries(affected)
    .filter(([, flag]) => flag)
    .map(([step]) => step);

  const unaffectedSteps = Object.entries(affected)
    .filter(([, flag]) => !flag)
    .map(([step]) => step);

  if (affectedSteps.length === 0) {
    return { scope: 'none' };
  }

  if (affectedSteps.length >= 3) {
    // 3+ steps affected → full re-run is more efficient
    return { scope: 'full' };
  }

  return {
    scope: 'partial',
    affectedSteps,
    unaffectedArtifacts: unaffectedSteps.map(s => STEP_ARTIFACT_MAP[s]),
  };
}

/**
 * Save cache after a partial re-run (merge existing + new artifacts).
 *
 * Reused artifacts are kept from the existing cache; only newly generated artifacts are overwritten.
 * Updates the manifest with a new commit_hash and cache_key, and records partial_rerun metadata.
 *
 * @param {string} cwd - Working directory
 * @param {object} options
 * @param {string[]} options.reusedArtifacts - List of reused artifact filenames
 * @param {Object<string, string>} options.newArtifacts - Newly generated artifacts (filename -> content)
 * @param {string} options.originalKey - Previous cache key
 * @param {string} options.newCacheKey - Newly computed cache key
 * @param {string} options.complexityGrade - Complexity grade
 * @returns {{ saved: boolean, cacheDir: string, artifactCount: number }}
 */
export function partialCacheSave(cwd, { reusedArtifacts, newArtifacts, originalKey, newCacheKey, complexityGrade }) {
  const cacheDir = join(cwd, CACHE_DIR);

  try {
    mkdirSync(cacheDir, { recursive: true });

    // Write new artifacts (output of affected steps)
    for (const [name, content] of Object.entries(newArtifacts)) {
      writeFileSync(join(cacheDir, name), content, 'utf-8');
    }

    // Verify reused artifacts already exist in the cache directory
    for (const name of reusedArtifacts) {
      if (!existsSync(join(cacheDir, name))) {
        // Not in cache directory — attempt to copy from phase0 output
        const phase0Path = join(cwd, '.mpl/mpl/phase0', name);
        if (existsSync(phase0Path)) {
          copyFileSync(phase0Path, join(cacheDir, name));
        }
      }
    }

    const allArtifacts = [...reusedArtifacts, ...Object.keys(newArtifacts)];
    const rerunSteps = Object.entries(STEP_ARTIFACT_MAP)
      .filter(([, artifact]) => artifact in newArtifacts || Object.keys(newArtifacts).includes(artifact))
      .map(([step]) => step);
    const reusedSteps = Object.entries(STEP_ARTIFACT_MAP)
      .filter(([, artifact]) => reusedArtifacts.includes(artifact))
      .map(([step]) => step);

    // Update manifest (includes partial_rerun metadata)
    const manifest = {
      cache_key: newCacheKey,
      commit_hash: getHeadCommitHash(cwd),
      timestamp: new Date().toISOString(),
      complexity_grade: complexityGrade,
      artifacts: [...new Set(allArtifacts)],
      partial_rerun: true,
      rerun_steps: rerunSteps,
      reused_steps: reusedSteps,
      original_cache_key: originalKey,
    };
    writeFileSync(join(cacheDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf-8');

    return { saved: true, cacheDir, artifactCount: allArtifacts.length };
  } catch {
    return { saved: false, cacheDir, artifactCount: 0 };
  }
}
