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

    // Write manifest (commit_hash 포함 — F-05 부분 무효화 diff 기준점)
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
// F-05: Partial Cache Invalidation (git diff 기반 부분 무효화)
// ---------------------------------------------------------------------------

/** Phase 0 단계별 아티팩트 매핑 */
const STEP_ARTIFACT_MAP = {
  api_contracts: 'api-contracts.md',
  examples: 'examples.md',
  type_policy: 'type-policy.md',
  error_spec: 'error-spec.md',
};

/**
 * 현재 HEAD의 commit hash를 반환한다.
 * git 저장소가 아니거나 실패 시 null 반환.
 *
 * @param {string} cwd - 워킹 디렉토리
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
 * 파일 경로가 공개 API 소스인지 판별한다.
 *
 * @param {string} filePath - 프로젝트 루트 기준 상대 경로
 * @returns {boolean}
 */
function isPublicApi(filePath) {
  if (isTestFile(filePath)) return false;

  const sourceExts = /\.(ts|js|py|go|rs|java|c|cpp)$/;
  if (!sourceExts.test(filePath)) return false;

  // 소스 디렉토리 패턴 (일반적인 프로젝트 레이아웃)
  const sourceDirPatterns = ['src/', 'lib/', 'app/', 'pkg/', 'packages/', 'core/', 'internal/'];
  const normalized = filePath.replace(/\\/g, '/');

  // 소스 디렉토리 내 파일이거나 루트 레벨 소스 파일
  return sourceDirPatterns.some(dir => normalized.includes(dir))
    || !normalized.includes('/');  // 루트 레벨 (e.g., main.py, index.ts)
}

/**
 * 파일 경로가 테스트 파일인지 판별한다.
 *
 * @param {string} filePath - 프로젝트 루트 기준 상대 경로
 * @returns {boolean}
 */
function isTestFile(filePath) {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath)
    || /\/test_[^/]+\.py$/.test(filePath)
    || /_test\.(go|rs)$/.test(filePath);
}

/**
 * 파일 경로가 타입 정의 파일인지 판별한다.
 *
 * @param {string} filePath - 프로젝트 루트 기준 상대 경로
 * @returns {boolean}
 */
function isTypeDefinition(filePath) {
  return /\.d\.ts$/.test(filePath)
    || /\/types\.(ts|py)$/.test(filePath)
    || /\/interfaces\.ts$/.test(filePath)
    || /\/models\.py$/.test(filePath);
}

/**
 * 파일 경로가 에러 핸들러 파일인지 판별한다.
 * 파일명 패턴으로만 판별하며, 내용 검사는 호출자가 필요 시 수행한다.
 *
 * @param {string} filePath - 프로젝트 루트 기준 상대 경로
 * @returns {boolean}
 */
function isErrorHandler(filePath) {
  const base = basename(filePath);
  return /^error/i.test(base) || /^exception/i.test(base);
}

/**
 * git diff 기반 부분 무효화 분석.
 *
 * 캐시 manifest의 commit_hash(또는 timestamp)를 기준으로 변경된 파일을 분석하고,
 * 영향받는 Phase 0 단계를 분류한다.
 *
 * @param {string} cwd - 워킹 디렉토리
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

  // diff 기준점 결정: commit_hash 우선, 없으면 timestamp 폴백
  const diffRef = manifest.commit_hash || null;
  if (!diffRef) {
    // commit_hash 없는 레거시 캐시 — 안전하게 전체 재실행
    return { scope: 'full' };
  }

  // git diff 실행
  let changedFiles;
  try {
    const output = execSync(`git diff --name-only ${diffRef} HEAD`, {
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    changedFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    // git diff 실패 — 안전 폴백으로 전체 재실행
    return { scope: 'full' };
  }

  if (changedFiles.length === 0) {
    return { scope: 'none' };
  }

  // 변경 파일을 Phase 0 단계별로 분류
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
    // 3+ 단계 영향 → 전체 재실행이 효율적
    return { scope: 'full' };
  }

  return {
    scope: 'partial',
    affectedSteps,
    unaffectedArtifacts: unaffectedSteps.map(s => STEP_ARTIFACT_MAP[s]),
  };
}

/**
 * 부분 재실행 후 캐시 저장 (기존 + 새 아티팩트 병합).
 *
 * 재사용 아티팩트는 기존 캐시에서 유지하고, 새로 생성된 아티팩트만 덮어쓴다.
 * 새 commit_hash 및 cache_key로 manifest를 갱신하며 partial_rerun 메타데이터를 기록한다.
 *
 * @param {string} cwd - 워킹 디렉토리
 * @param {object} options
 * @param {string[]} options.reusedArtifacts - 재사용된 아티팩트 파일명 목록
 * @param {Object<string, string>} options.newArtifacts - 새로 생성된 아티팩트 (filename -> content)
 * @param {string} options.originalKey - 이전 캐시 키
 * @param {string} options.newCacheKey - 새로 계산된 캐시 키
 * @param {string} options.complexityGrade - 복잡도 등급
 * @returns {{ saved: boolean, cacheDir: string, artifactCount: number }}
 */
export function partialCacheSave(cwd, { reusedArtifacts, newArtifacts, originalKey, newCacheKey, complexityGrade }) {
  const cacheDir = join(cwd, CACHE_DIR);

  try {
    mkdirSync(cacheDir, { recursive: true });

    // 새 아티팩트 기록 (영향받은 단계의 결과물)
    for (const [name, content] of Object.entries(newArtifacts)) {
      writeFileSync(join(cacheDir, name), content, 'utf-8');
    }

    // 재사용 아티팩트가 캐시 디렉토리에 이미 존재하는지 확인
    for (const name of reusedArtifacts) {
      if (!existsSync(join(cacheDir, name))) {
        // 캐시 디렉토리에 없으면 phase0 출력에서 복사 시도
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

    // manifest 갱신 (partial_rerun 메타데이터 포함)
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
