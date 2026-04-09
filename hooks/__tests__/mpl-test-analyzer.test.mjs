import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { analyzeFile, analyzeDirectory, generateContractsMd } from '../lib/mpl-test-analyzer.mjs';

function createTempDir() {
  const dir = join(tmpdir(), `mpl-analyzer-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_TEST = `
import pytest
from mymodule import TaskRunner, parse_config

@pytest.fixture
def sample_config(tmp_path):
    return {"name": "test", "path": str(tmp_path)}

@pytest.fixture
def runner(sample_config):
    return TaskRunner(sample_config)

def test_create_runner(sample_config):
    runner = TaskRunner(sample_config)
    assert runner.name == "test"
    assert runner.is_valid() == True

def test_run_tasks(runner):
    result = runner.run_tasks(["task1", "task2"], timeout=30)
    assert len(result.completed) == 2
    assert result.status == "success"

def test_invalid_config():
    with pytest.raises(ValueError, match=r'[Ii]nvalid config'):
        TaskRunner(None)

def test_empty_tasks(runner):
    with pytest.raises(TypeError):
        runner.run_tasks([])

def test_parse_config():
    config = parse_config("test.yaml", strict=True)
    assert config is not None
    assert "name" in config
`;

describe('analyzeFile', () => {
  let tempDir;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return empty contracts for non-existent file', () => {
    const result = analyzeFile('/nonexistent/test_foo.py');
    assert.equal(result.calls.length, 0);
    assert.equal(result.exceptions.length, 0);
  });

  it('should extract function calls', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = analyzeFile(filePath);
    const taskRunnerCall = result.calls.find(c => c.name === 'TaskRunner');
    assert.ok(taskRunnerCall, 'Should find TaskRunner call');
  });

  it('should extract keyword arguments', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = analyzeFile(filePath);
    const runTasksCall = result.calls.find(c => c.name === 'runner.run_tasks');
    assert.ok(runTasksCall, 'Should find runner.run_tasks call');
    assert.ok(runTasksCall.kwargs.includes('timeout'), 'Should detect timeout kwarg');
  });

  it('should extract pytest.raises with match pattern', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = analyzeFile(filePath);
    const valueError = result.exceptions.find(e => e.exceptionType === 'ValueError');
    assert.ok(valueError, 'Should find ValueError');
    assert.ok(valueError.matchPattern, 'Should have match pattern');
    assert.ok(valueError.matchPattern.includes('nvalid config'));
  });

  it('should extract pytest.raises without match pattern', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = analyzeFile(filePath);
    const typeError = result.exceptions.find(e => e.exceptionType === 'TypeError');
    assert.ok(typeError, 'Should find TypeError');
    assert.equal(typeError.matchPattern, null);
  });

  it('should extract assert statements with operators', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = analyzeFile(filePath);
    assert.ok(result.asserts.length > 0, 'Should find assert statements');
    const eqAssert = result.asserts.find(a => a.operator === '==');
    assert.ok(eqAssert, 'Should find == assertion');
    const inAssert = result.asserts.find(a => a.operator === 'in');
    assert.ok(inAssert, 'Should find "in" assertion');
  });

  it('should extract fixtures with dependencies', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const result = analyzeFile(filePath);
    assert.ok(result.fixtures.length >= 2, 'Should find at least 2 fixtures');
    const runnerFixture = result.fixtures.find(f => f.name === 'runner');
    assert.ok(runnerFixture, 'Should find runner fixture');
    assert.ok(runnerFixture.params.includes('sample_config'), 'runner should depend on sample_config');
  });
});

describe('analyzeDirectory', () => {
  let tempDir;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return empty for non-existent directory', () => {
    assert.deepEqual(analyzeDirectory('/nonexistent/dir'), []);
  });

  it('should analyze only test_ prefixed .py files', () => {
    writeFileSync(join(tempDir, 'test_one.py'), 'def test_a():\n    assert True\n');
    writeFileSync(join(tempDir, 'test_two.py'), 'def test_b():\n    assert False\n');
    writeFileSync(join(tempDir, 'helper.py'), 'def helper():\n    pass\n');
    writeFileSync(join(tempDir, 'test_skip.txt'), 'not python');

    const results = analyzeDirectory(tempDir);
    assert.equal(results.length, 2);
  });
});

describe('generateContractsMd', () => {
  let tempDir;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should generate markdown from contracts', () => {
    const filePath = join(tempDir, 'test_sample.py');
    writeFileSync(filePath, SAMPLE_TEST);
    const contracts = [analyzeFile(filePath)];
    const md = generateContractsMd(contracts);

    assert.ok(md.includes('# API Contract Specification'));
    assert.ok(md.includes('Function Calls'));
    assert.ok(md.includes('Exception Specifications'));
    assert.ok(md.includes('Fixtures'));
    assert.ok(md.includes('ValueError'));
  });

  it('should skip files with no contracts', () => {
    const contracts = [{ file: 'empty.py', calls: [], exceptions: [], asserts: [], fixtures: [] }];
    const md = generateContractsMd(contracts);
    assert.ok(!md.includes('empty.py'));
  });
});
