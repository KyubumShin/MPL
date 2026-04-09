import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { detectPatterns, generateExamplesMd } from '../lib/mpl-pattern-detector.mjs';

function createTempDir() {
  const dir = join(tmpdir(), `mpl-pattern-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_TEST = `
import pytest
from mymodule import TaskRunner, parse_config
from mymodule.utils import validate

@pytest.fixture
def config():
    return {"name": "default", "timeout": 30}

@pytest.fixture
def runner(config):
    return TaskRunner(config)

def test_create_runner(config):
    runner = TaskRunner(config)
    assert runner.name == "default"
    assert runner is not None

def test_run_sorted(runner):
    result = runner.get_names()
    assert result == sorted(result)

def test_side_effect(runner):
    runner.execute("task1")
    assert runner.completed_count == 1

def test_invalid_input():
    with pytest.raises(ValueError, match=r'invalid'):
        TaskRunner(None)

def test_with_defaults(runner):
    result = runner.run(retries=3, verbose=False)
    assert result.status == "ok"

def test_membership(runner):
    names = runner.get_names()
    assert "task1" in names
`;

describe('detectPatterns', () => {
  let tempDir;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return empty for non-existent file', () => {
    const result = detectPatterns('/nonexistent/test.py');
    assert.equal(result.patterns.length, 0);
  });

  it('should detect creation patterns', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const creations = result.patterns.filter(p => p.category === 'creation');
    assert.ok(creations.length > 0, 'Should find creation patterns');
    assert.ok(creations.some(c => c.description.includes('TaskRunner')));
  });

  it('should detect validation patterns', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const validations = result.patterns.filter(p => p.category === 'validation');
    assert.ok(validations.length > 0, 'Should find validation patterns');
    const types = validations.map(v => v.description);
    assert.ok(types.some(t => t.includes('equality')), 'Should find equality assertion');
    assert.ok(types.some(t => t.includes('membership')), 'Should find membership assertion');
  });

  it('should detect error patterns', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const errors = result.patterns.filter(p => p.category === 'error');
    assert.ok(errors.length > 0, 'Should find error patterns');
    assert.ok(errors.some(e => e.description.includes('ValueError')));
  });

  it('should detect ordering patterns', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const ordering = result.patterns.filter(p => p.category === 'ordering');
    assert.ok(ordering.length > 0, 'Should find ordering patterns');
    assert.ok(ordering.some(o => o.description.includes('sorted')));
  });

  it('should detect side-effect patterns', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const sideEffects = result.patterns.filter(p => p.category === 'side_effect');
    assert.ok(sideEffects.length > 0, 'Should find side-effect patterns');
  });

  it('should detect default patterns', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const defaults = result.patterns.filter(p => p.category === 'default');
    assert.ok(defaults.length > 0, 'Should find default patterns');
  });

  it('should detect integration patterns (multi-module)', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const integrations = result.patterns.filter(p => p.category === 'integration');
    assert.ok(integrations.length > 0, 'Should find integration patterns');
    assert.ok(integrations[0].description.includes('mymodule'));
  });

  it('should produce correct summary counts', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const totalFromSummary = Object.values(result.summary).reduce((a, b) => a + b, 0);
    assert.equal(totalFromSummary, result.patterns.length);
  });
});

describe('generateExamplesMd', () => {
  let tempDir;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should generate markdown with all detected categories', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const md = generateExamplesMd([result]);

    assert.ok(md.includes('# Example Pattern Analysis'));
    assert.ok(md.includes('Creation Patterns'));
    assert.ok(md.includes('Validation Patterns'));
    assert.ok(md.includes('Error Patterns'));
    assert.ok(md.includes('Summary'));
  });

  it('should include summary table', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = detectPatterns(filePath);
    const md = generateExamplesMd([result]);

    assert.ok(md.includes('| Category |'));
    assert.ok(md.includes('| Count |'));
    assert.ok(md.includes('High'));
  });

  it('should handle empty results', () => {
    const md = generateExamplesMd([{ file: 'empty.py', patterns: [], summary: {} }]);
    assert.ok(md.includes('# Example Pattern Analysis'));
    assert.ok(!md.includes('Creation Patterns'));
  });
});
