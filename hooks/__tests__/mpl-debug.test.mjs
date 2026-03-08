import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import {
  getDebugConfig,
  isDebugEnabled,
  debugLog,
  debugDecision,
  debugTransition,
  debugError,
} from '../lib/mpl-debug.mjs';

function makeTmpDir() {
  const dir = join(tmpdir(), `mpl-debug-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(cwd, config) {
  const configDir = join(cwd, '.mpl');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
}

function readLog(cwd) {
  const logPath = join(cwd, '.mpl', 'mpl', 'debug.log');
  if (!existsSync(logPath)) return '';
  return readFileSync(logPath, 'utf-8');
}

describe('getDebugConfig', () => {
  let cwd;
  beforeEach(() => { cwd = makeTmpDir(); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('should return disabled when no config exists', () => {
    const config = getDebugConfig(cwd);
    assert.equal(config.enabled, false);
  });

  it('should return disabled when debug not in config', () => {
    writeConfig(cwd, { max_fix_loops: 10 });
    const config = getDebugConfig(cwd);
    assert.equal(config.enabled, false);
  });

  it('should accept boolean shorthand', () => {
    writeConfig(cwd, { debug: true });
    const config = getDebugConfig(cwd);
    assert.equal(config.enabled, true);
    assert.deepEqual(config.categories, ['all']);
  });

  it('should accept object with categories', () => {
    writeConfig(cwd, { debug: { enabled: true, categories: ['triage', 'gate'] } });
    const config = getDebugConfig(cwd);
    assert.equal(config.enabled, true);
    assert.deepEqual(config.categories, ['triage', 'gate']);
  });

  it('should return disabled when enabled=false', () => {
    writeConfig(cwd, { debug: { enabled: false } });
    assert.equal(isDebugEnabled(cwd), false);
  });
});

describe('debugLog', () => {
  let cwd;
  beforeEach(() => { cwd = makeTmpDir(); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('should not write when debug disabled', () => {
    writeConfig(cwd, { debug: false });
    const result = debugLog(cwd, 'triage', 'test message');
    assert.equal(result, false);
    assert.equal(readLog(cwd), '');
  });

  it('should write timestamped entry when enabled', () => {
    writeConfig(cwd, { debug: true });
    debugLog(cwd, 'triage', 'Tier selected');
    const log = readLog(cwd);
    assert.match(log, /\[TRIAGE\] Tier selected/);
    assert.match(log, /^\[20\d{2}-/); // ISO timestamp
  });

  it('should include context when provided', () => {
    writeConfig(cwd, { debug: true });
    debugLog(cwd, 'triage', 'Score computed', { score: 0.72, tier: 'frontier' });
    const log = readLog(cwd);
    assert.match(log, /"score":0\.72/);
    assert.match(log, /"tier":"frontier"/);
  });

  it('should append multiple entries', () => {
    writeConfig(cwd, { debug: true });
    debugLog(cwd, 'triage', 'First');
    debugLog(cwd, 'gate', 'Second');
    const log = readLog(cwd);
    assert.match(log, /First/);
    assert.match(log, /Second/);
    assert.equal(log.trim().split('\n').length, 2);
  });

  it('should filter by category', () => {
    writeConfig(cwd, { debug: { enabled: true, categories: ['gate'] } });
    debugLog(cwd, 'triage', 'Should not appear');
    debugLog(cwd, 'gate', 'Should appear');
    const log = readLog(cwd);
    assert.ok(!log.includes('Should not appear'));
    assert.ok(log.includes('Should appear'));
  });

  it('should log all categories when categories=["all"]', () => {
    writeConfig(cwd, { debug: { enabled: true, categories: ['all'] } });
    debugLog(cwd, 'triage', 'A');
    debugLog(cwd, 'gate', 'B');
    debugLog(cwd, 'escalation', 'C');
    const log = readLog(cwd);
    const lines = log.trim().split('\n');
    assert.equal(lines.length, 3);
  });
});

describe('debugDecision', () => {
  let cwd;
  beforeEach(() => { cwd = makeTmpDir(); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('should log decision with inputs and reasoning', () => {
    writeConfig(cwd, { debug: true });
    debugDecision(cwd, 'model-selection', 'Use opus for phase-runner', { complexity: 'L' }, 'Architecture change detected');
    const log = readLog(cwd);
    assert.match(log, /\[MODEL-SELECTION\] DECISION: Use opus/);
    assert.match(log, /"reasoning":"Architecture change detected"/);
    assert.match(log, /"type":"decision"/);
  });
});

describe('debugTransition', () => {
  let cwd;
  beforeEach(() => { cwd = makeTmpDir(); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('should log state transition', () => {
    writeConfig(cwd, { debug: true });
    debugTransition(cwd, 'mpl-phase-running', 'mpl-phase-complete', 'phase-3 completed');
    const log = readLog(cwd);
    assert.match(log, /\[STATE-CHANGE\] mpl-phase-running → mpl-phase-complete/);
    assert.match(log, /"trigger":"phase-3 completed"/);
  });
});

describe('debugError', () => {
  let cwd;
  beforeEach(() => { cwd = makeTmpDir(); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('should always log errors regardless of category filter', () => {
    writeConfig(cwd, { debug: { enabled: true, categories: ['gate'] } });
    debugError(cwd, 'Unexpected state', { phase: 'phase-2' });
    const log = readLog(cwd);
    assert.match(log, /\[ERROR\] Unexpected state/);
  });

  it('should not log when debug disabled', () => {
    writeConfig(cwd, { debug: false });
    debugError(cwd, 'Should not appear');
    assert.equal(readLog(cwd), '');
  });
});
