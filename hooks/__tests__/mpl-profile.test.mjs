import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { parseJsonl, analyzeProfile, detectAnomalies, readRunSummary, formatReport } from '../lib/mpl-profile.mjs';

function createTempDir() {
  const dir = join(tmpdir(), `mpl-profile-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePhases(tempDir, entries) {
  const profileDir = join(tempDir, '.mpl', 'mpl', 'profile');
  mkdirSync(profileDir, { recursive: true });
  const content = entries.map(e => JSON.stringify(e)).join('\n');
  writeFileSync(join(profileDir, 'phases.jsonl'), content);
  return profileDir;
}

describe('parseJsonl', () => {
  let tempDir;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return empty array for non-existent file', () => {
    assert.deepEqual(parseJsonl('/nonexistent/file.jsonl'), []);
  });

  it('should parse valid JSONL', () => {
    const filePath = join(tempDir, 'test.jsonl');
    writeFileSync(filePath, '{"a":1}\n{"b":2}\n');
    const result = parseJsonl(filePath);
    assert.equal(result.length, 2);
    assert.equal(result[0].a, 1);
    assert.equal(result[1].b, 2);
  });

  it('should skip malformed lines', () => {
    const filePath = join(tempDir, 'test.jsonl');
    writeFileSync(filePath, '{"a":1}\nnot json\n{"b":2}\n');
    const result = parseJsonl(filePath);
    assert.equal(result.length, 2);
  });

  it('should handle empty lines', () => {
    const filePath = join(tempDir, 'test.jsonl');
    writeFileSync(filePath, '{"a":1}\n\n\n{"b":2}\n');
    const result = parseJsonl(filePath);
    assert.equal(result.length, 2);
  });
});

describe('analyzeProfile', () => {
  let tempDir;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return empty result when no profile data', () => {
    const result = analyzeProfile(tempDir);
    assert.deepEqual(result.phases, []);
    assert.equal(result.totals, null);
    assert.deepEqual(result.anomalies, []);
  });

  it('should compute correct totals', () => {
    writePhases(tempDir, [
      { step: 'phase-1', name: 'Models', pass_rate: 100, micro_fixes: 0, retries: 0, estimated_tokens: { context: 5000, output: 2000, total: 7000 }, duration_ms: 30000 },
      { step: 'phase-2', name: 'Logic', pass_rate: 95, micro_fixes: 1, retries: 0, estimated_tokens: { context: 8000, output: 3000, total: 11000 }, duration_ms: 45000 },
    ]);

    const result = analyzeProfile(tempDir);
    assert.equal(result.totals.phases, 2);
    assert.equal(result.totals.tokens, 18000);
    assert.equal(result.totals.duration_ms, 75000);
    assert.equal(result.totals.micro_fixes, 1);
    assert.equal(result.totals.avg_tokens_per_phase, 9000);
  });

  it('should handle entries with missing fields', () => {
    writePhases(tempDir, [
      { step: 'phase-1' },
      { name: 'Unnamed' },
    ]);
    const result = analyzeProfile(tempDir);
    assert.equal(result.totals.phases, 2);
    assert.equal(result.totals.tokens, 0);
  });
});

describe('detectAnomalies', () => {
  it('should detect token overuse (>2x average)', () => {
    const phases = [
      { step: 'phase-1', tokens: 5000, micro_fixes: 0, pass_rate: 100 },
      { step: 'phase-2', tokens: 35000, micro_fixes: 0, pass_rate: 100 },
    ];
    const anomalies = detectAnomalies(phases, 10000);
    const tokenAnomaly = anomalies.find(a => a.type === 'token_overuse');
    assert.ok(tokenAnomaly);
    assert.equal(tokenAnomaly.phase, 'phase-2');
  });

  it('should detect excessive micro-fixes (5+)', () => {
    const phases = [
      { step: 'phase-1', tokens: 5000, micro_fixes: 6, pass_rate: 100 },
    ];
    const anomalies = detectAnomalies(phases, 5000);
    const fixAnomaly = anomalies.find(a => a.type === 'excessive_fixes');
    assert.ok(fixAnomaly);
  });

  it('should detect low pass rate (<80%)', () => {
    const phases = [
      { step: 'phase-1', tokens: 5000, micro_fixes: 0, pass_rate: 60 },
    ];
    const anomalies = detectAnomalies(phases, 5000);
    const passAnomaly = anomalies.find(a => a.type === 'low_pass_rate');
    assert.ok(passAnomaly);
    assert.equal(passAnomaly.severity, 'error');
  });

  it('should return empty array for healthy phases', () => {
    const phases = [
      { step: 'phase-1', tokens: 5000, micro_fixes: 1, pass_rate: 100 },
      { step: 'phase-2', tokens: 6000, micro_fixes: 0, pass_rate: 95 },
    ];
    const anomalies = detectAnomalies(phases, 5500);
    assert.equal(anomalies.length, 0);
  });
});

describe('readRunSummary', () => {
  let tempDir;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should return null when no summary file', () => {
    assert.equal(readRunSummary(tempDir), null);
  });

  it('should parse valid summary', () => {
    const profileDir = join(tempDir, '.mpl', 'mpl', 'profile');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'run-summary.json'), JSON.stringify({
      run_id: 'mpl-123', complexity: { grade: 'Complex', score: 85 }
    }));
    const result = readRunSummary(tempDir);
    assert.equal(result.run_id, 'mpl-123');
    assert.equal(result.complexity.grade, 'Complex');
  });
});

describe('formatReport', () => {
  it('should handle empty analysis', () => {
    const report = formatReport({ phases: [], totals: null, anomalies: [] });
    assert.ok(report.includes('No profile data found'));
  });

  it('should produce formatted report with data', () => {
    const analysis = {
      phases: [
        { step: 'phase-1', name: 'Models', tokens: 7000, pass_rate: 100, micro_fixes: 0, duration_ms: 30000 },
        { step: 'phase-2', name: 'Logic', tokens: 11000, pass_rate: 95, micro_fixes: 1, duration_ms: 45000 },
      ],
      totals: { phases: 2, tokens: 18000, duration_ms: 75000, micro_fixes: 1, retries: 0, avg_tokens_per_phase: 9000 },
      anomalies: [],
    };
    const report = formatReport(analysis);
    assert.ok(report.includes('MPL Token Profile Report'));
    assert.ok(report.includes('18,000'));
    assert.ok(report.includes('phase-1'));
    assert.ok(report.includes('No anomalies detected'));
  });

  it('should include anomalies in report', () => {
    const analysis = {
      phases: [{ step: 'phase-1', tokens: 50000, pass_rate: 60, micro_fixes: 7, duration_ms: 10000 }],
      totals: { phases: 1, tokens: 50000, duration_ms: 10000, micro_fixes: 7, retries: 0, avg_tokens_per_phase: 50000 },
      anomalies: [
        { severity: 'error', phase: 'phase-1', type: 'low_pass_rate', description: 'phase-1 pass rate 60%' },
        { severity: 'warning', phase: 'phase-1', type: 'excessive_fixes', description: 'phase-1 required 7 micro-fixes' },
      ],
    };
    const report = formatReport(analysis);
    assert.ok(report.includes('[ERROR]'));
    assert.ok(report.includes('[WARN]'));
  });

  it('should include run summary when provided', () => {
    const analysis = {
      phases: [{ step: 'phase-1', tokens: 5000, pass_rate: 100, micro_fixes: 0, duration_ms: 10000 }],
      totals: { phases: 1, tokens: 5000, duration_ms: 10000, micro_fixes: 0, retries: 0, avg_tokens_per_phase: 5000 },
      anomalies: [],
    };
    const summary = { run_id: 'mpl-abc', complexity: { grade: 'Simple', score: 20 }, cache: { phase0_hit: true, saved_tokens: 8000 } };
    const report = formatReport(analysis, summary);
    assert.ok(report.includes('mpl-abc'));
    assert.ok(report.includes('Simple'));
    assert.ok(report.includes('HIT'));
  });
});
