import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { generateCacheKey, checkCache, validateCache, saveCache, readCachedArtifact, invalidateCache, DEFAULT_TTL_MS, analyzePartialInvalidation, partialCacheSave } from '../lib/mpl-cache.mjs';

function createTempDir() {
  const dir = join(tmpdir(), `mpl-cache-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('generateCacheKey', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return a 64-char hex string (SHA-256)', () => {
    const key = generateCacheKey({ testFiles: [], structureDirs: [], externalDeps: [], sourceFiles: [] });
    assert.equal(key.length, 64);
    assert.match(key, /^[a-f0-9]{64}$/);
  });

  it('should produce different keys for different inputs', () => {
    const key1 = generateCacheKey({ testFiles: [], structureDirs: ['src'], externalDeps: [], sourceFiles: [] });
    const key2 = generateCacheKey({ testFiles: [], structureDirs: ['lib'], externalDeps: [], sourceFiles: [] });
    assert.notEqual(key1, key2);
  });

  it('should produce the same key for same inputs', () => {
    const inputs = { testFiles: [], structureDirs: ['src', 'lib'], externalDeps: ['lodash'], sourceFiles: [] };
    const key1 = generateCacheKey(inputs);
    const key2 = generateCacheKey(inputs);
    assert.equal(key1, key2);
  });

  it('should incorporate file contents into the key', () => {
    const testFile = join(tempDir, 'test.py');
    writeFileSync(testFile, 'def test_a(): pass');
    const key1 = generateCacheKey({ testFiles: [testFile], structureDirs: [], externalDeps: [], sourceFiles: [] });

    writeFileSync(testFile, 'def test_b(): pass');
    const key2 = generateCacheKey({ testFiles: [testFile], structureDirs: [], externalDeps: [], sourceFiles: [] });

    assert.notEqual(key1, key2);
  });

  it('should skip non-existent files gracefully', () => {
    const key = generateCacheKey({ testFiles: ['/nonexistent/file.py'], structureDirs: [], externalDeps: [], sourceFiles: [] });
    assert.equal(key.length, 64);
  });
});

describe('checkCache', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return hit=false when no cache directory exists', () => {
    const result = checkCache(tempDir);
    assert.equal(result.hit, false);
    assert.equal(result.manifest, null);
  });

  it('should return hit=false when manifest is missing', () => {
    mkdirSync(join(tempDir, '.mpl', 'cache', 'phase0'), { recursive: true });
    const result = checkCache(tempDir);
    assert.equal(result.hit, false);
  });

  it('should return hit=false when manifest is invalid JSON', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'manifest.json'), 'not json');
    const result = checkCache(tempDir);
    assert.equal(result.hit, false);
  });

  it('should return hit=false when artifact files are missing', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
      cache_key: 'abc', timestamp: '2026-01-01', artifacts: ['error-spec.md']
    }));
    const result = checkCache(tempDir);
    assert.equal(result.hit, false);
  });

  it('should return hit=true when manifest and all artifacts exist', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'error-spec.md'), '# Error Spec');
    writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
      cache_key: 'abc123', timestamp: new Date().toISOString(), artifacts: ['error-spec.md']
    }));
    const result = checkCache(tempDir);
    assert.equal(result.hit, true);
    assert.equal(result.manifest.cache_key, 'abc123');
  });
});

describe('validateCache', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return valid=false with reason no_cache when no cache', () => {
    const result = validateCache(tempDir, 'somekey');
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'no_cache');
  });

  it('should return valid=false with reason key_mismatch', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'error-spec.md'), '# Error Spec');
    writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
      cache_key: 'old_key', timestamp: new Date().toISOString(), artifacts: ['error-spec.md']
    }));
    const result = validateCache(tempDir, 'new_key');
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'key_mismatch');
  });

  it('should return valid=true when keys match', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'error-spec.md'), '# Error Spec');
    writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
      cache_key: 'matching_key', timestamp: new Date().toISOString(), artifacts: ['error-spec.md']
    }));
    const result = validateCache(tempDir, 'matching_key');
    assert.equal(result.valid, true);
    assert.equal(result.reason, 'valid');
  });
});

describe('saveCache', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should save artifacts and manifest', () => {
    const result = saveCache(tempDir, {
      cacheKey: 'test_key_123',
      complexityGrade: 'Simple',
      artifacts: {
        'error-spec.md': '# Error Specification\n\n## Errors',
        'summary.md': '# Phase 0 Summary',
      }
    });

    assert.equal(result.saved, true);
    assert.equal(result.artifactCount, 2);

    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    assert.ok(existsSync(join(cacheDir, 'error-spec.md')));
    assert.ok(existsSync(join(cacheDir, 'summary.md')));
    assert.ok(existsSync(join(cacheDir, 'manifest.json')));

    const manifest = JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.cache_key, 'test_key_123');
    assert.equal(manifest.complexity_grade, 'Simple');
    assert.deepEqual(manifest.artifacts, ['error-spec.md', 'summary.md']);
  });

  it('should create cache directory if it does not exist', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    assert.ok(!existsSync(cacheDir));

    saveCache(tempDir, { cacheKey: 'k', complexityGrade: 'Medium', artifacts: { 'a.md': 'content' } });
    assert.ok(existsSync(cacheDir));
  });
});

describe('readCachedArtifact', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return null for non-existent artifact', () => {
    assert.equal(readCachedArtifact(tempDir, 'missing.md'), null);
  });

  it('should return file content for existing artifact', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'error-spec.md'), '# Errors\nValueError');

    const content = readCachedArtifact(tempDir, 'error-spec.md');
    assert.equal(content, '# Errors\nValueError');
  });
});

describe('checkCache TTL', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return hit=false with reason=expired for old cache', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'error-spec.md'), '# Errors');
    const oldTimestamp = new Date(Date.now() - DEFAULT_TTL_MS - 1000).toISOString();
    writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
      cache_key: 'abc', timestamp: oldTimestamp, artifacts: ['error-spec.md']
    }));
    const result = checkCache(tempDir);
    assert.equal(result.hit, false);
    assert.equal(result.reason, 'expired');
  });

  it('should return hit=true for cache within TTL', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'error-spec.md'), '# Errors');
    const recentTimestamp = new Date(Date.now() - 1000).toISOString();
    writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
      cache_key: 'abc', timestamp: recentTimestamp, artifacts: ['error-spec.md']
    }));
    const result = checkCache(tempDir);
    assert.equal(result.hit, true);
  });

  it('should expose DEFAULT_TTL_MS as 7 days in milliseconds', () => {
    assert.equal(DEFAULT_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  });
});

describe('invalidateCache', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return invalidated=false when no cache exists', () => {
    const result = invalidateCache(tempDir);
    assert.equal(result.invalidated, false);
  });

  it('should delete cache directory and return invalidated=true', () => {
    const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'error-spec.md'), '# Errors');
    writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
      cache_key: 'abc', timestamp: new Date().toISOString(), artifacts: ['error-spec.md']
    }));

    const result = invalidateCache(tempDir);
    assert.equal(result.invalidated, true);
    assert.equal(existsSync(cacheDir), false);
  });

  it('should make checkCache return hit=false after invalidation', () => {
    saveCache(tempDir, {
      cacheKey: 'test_key',
      complexityGrade: 'Simple',
      artifacts: { 'error-spec.md': '# Errors' }
    });
    assert.equal(checkCache(tempDir).hit, true);

    invalidateCache(tempDir);
    assert.equal(checkCache(tempDir).hit, false);
  });
});

describe('F-05: Partial Cache Invalidation', () => {
  describe('analyzePartialInvalidation', () => {
    let tempDir;

    beforeEach(() => { tempDir = createTempDir(); });
    afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

    it('should return scope: full when manifest does not exist', () => {
      const result = analyzePartialInvalidation(tempDir);
      assert.equal(result.scope, 'full');
    });

    it('should return scope: full when manifest has no commit_hash', () => {
      const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
        cache_key: 'test-key',
        timestamp: new Date().toISOString(),
        complexity_grade: 'Medium',
        artifacts: [],
      }));

      const result = analyzePartialInvalidation(tempDir);
      assert.equal(result.scope, 'full');
    });

    it('should return scope: full when git diff fails (non-git dir)', () => {
      // tempDir is not a git repo, so git diff will fail
      const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
        cache_key: 'test-key',
        commit_hash: 'deadbeef1234',
        timestamp: new Date().toISOString(),
        complexity_grade: 'Medium',
        artifacts: [],
      }));

      const result = analyzePartialInvalidation(tempDir);
      assert.equal(result.scope, 'full');
    });
  });

  describe('partialCacheSave', () => {
    let tempDir;

    beforeEach(() => { tempDir = createTempDir(); });
    afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

    it('should save new artifacts and write manifest with partial_rerun metadata', () => {
      const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
      mkdirSync(cacheDir, { recursive: true });

      // 기존 캐시 아티팩트 (재사용 대상)
      writeFileSync(join(cacheDir, 'api-contracts.md'), '# Cached API Contracts');
      writeFileSync(join(cacheDir, 'type-policy.md'), '# Cached Type Policy');

      const result = partialCacheSave(tempDir, {
        newCacheKey: 'new-key-123',
        complexityGrade: 'Medium',
        newArtifacts: { 'examples.md': '# New Examples' },
        reusedArtifacts: ['api-contracts.md', 'type-policy.md'],
        originalKey: 'old-key-456',
      });

      assert.equal(result.saved, true);

      const manifest = JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf-8'));
      assert.equal(manifest.cache_key, 'new-key-123');
      assert.equal(manifest.partial_rerun, true);
      assert.ok(Array.isArray(manifest.rerun_steps));
      assert.ok(Array.isArray(manifest.reused_steps));
      assert.equal(manifest.original_cache_key, 'old-key-456');
    });

    it('should include all artifact filenames in manifest artifacts array', () => {
      const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, 'type-policy.md'), '# Type Policy');

      partialCacheSave(tempDir, {
        newCacheKey: 'key-abc',
        complexityGrade: 'Simple',
        newArtifacts: { 'error-spec.md': '# Error Spec' },
        reusedArtifacts: ['type-policy.md'],
        originalKey: 'key-old',
      });

      const manifest = JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf-8'));
      assert.ok(manifest.artifacts.includes('type-policy.md'));
      assert.ok(manifest.artifacts.includes('error-spec.md'));
    });

    it('should copy reused artifact from phase0 output dir when not in cache', () => {
      const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
      const phase0Dir = join(tempDir, '.mpl', 'mpl', 'phase0');
      mkdirSync(cacheDir, { recursive: true });
      mkdirSync(phase0Dir, { recursive: true });

      // 재사용 대상이 캐시에 없고 phase0 출력 디렉토리에만 존재
      writeFileSync(join(phase0Dir, 'api-contracts.md'), '# API Contracts from phase0');

      partialCacheSave(tempDir, {
        newCacheKey: 'key-xyz',
        complexityGrade: 'Medium',
        newArtifacts: { 'examples.md': '# New Examples' },
        reusedArtifacts: ['api-contracts.md'],
        originalKey: 'key-prev',
      });

      // phase0 출력에서 캐시로 복사되었는지 확인
      assert.ok(existsSync(join(cacheDir, 'api-contracts.md')));
      assert.equal(
        readFileSync(join(cacheDir, 'api-contracts.md'), 'utf-8'),
        '# API Contracts from phase0'
      );
    });

    it('should return saved=true and correct artifactCount', () => {
      const cacheDir = join(tempDir, '.mpl', 'cache', 'phase0');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, 'type-policy.md'), '# Type Policy');

      const result = partialCacheSave(tempDir, {
        newCacheKey: 'key-count',
        complexityGrade: 'Simple',
        newArtifacts: { 'error-spec.md': '# Errors', 'examples.md': '# Examples' },
        reusedArtifacts: ['type-policy.md'],
        originalKey: 'key-old',
      });

      assert.equal(result.saved, true);
      assert.equal(result.artifactCount, 3);
    });
  });
});
