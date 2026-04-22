import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

import {
  sha256File,
  sha256String,
  buildBaseline,
  serializeBaseline,
  writeBaseline,
  baselineExists,
  renewalAuthorized,
  BASELINE_FILE,
  RENEWAL_FLAG_FILE,
} from '../lib/mpl-baseline.mjs';

function createTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-baseline-'));
  execSync('git init -q', { cwd: dir });
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

describe('sha256String normalization', () => {
  it('strips CRLF and trims', () => {
    const a = sha256String('hello\r\nworld\r\n');
    const b = sha256String('hello\nworld');
    const c = sha256String('  hello\nworld  ');
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(sha256String(null), sha256String(''));
    assert.equal(sha256String(undefined), sha256String(''));
  });
});

describe('sha256File', () => {
  let dir;
  beforeEach(() => { dir = createTempRepo(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns sha for existing file', () => {
    writeFileSync(join(dir, 'foo.txt'), 'hello');
    const hash = sha256File(dir, 'foo.txt');
    assert.ok(hash);
    assert.equal(hash.length, 64);
  });

  it('returns null for missing file', () => {
    assert.equal(sha256File(dir, 'nope.txt'), null);
  });
});

describe('buildBaseline', () => {
  let dir;
  beforeEach(() => { dir = createTempRepo(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('captures git base_sha and artifact hashes', () => {
    mkdirSync(join(dir, '.mpl'), { recursive: true });
    writeFileSync(join(dir, '.mpl/pivot-points.md'), '## PP-1\nAuth is immutable');

    const b = buildBaseline(dir, {
      pipelineId: 'mpl-test',
      userRequest: 'build auth',
      accumulatedResponses: 'round 1: yes',
      ambiguity: { final_score: 0.18, threshold_met: true, override: null, rounds: 3 },
      codebaseSkipped: false,
    });

    assert.equal(b.pipeline_id, 'mpl-test');
    assert.ok(b.git.base_sha);
    assert.equal(b.git.base_branch.length > 0, true);
    assert.ok(b.artifacts.pivot_points);
    assert.equal(b.artifacts.pivot_points.sha256.length, 64);
    assert.equal(b.artifacts.core_scenarios, null);  // file absent
    assert.equal(b.ambiguity.final_score, 0.18);
    assert.equal(b.ambiguity.threshold_met, true);
    assert.equal(b.spec.user_request_hash.length, 64);
  });

  it('marks codebase as skipped for greenfield', () => {
    const b = buildBaseline(dir, {
      pipelineId: 'mpl-green',
      userRequest: 'new project',
      accumulatedResponses: '',
      ambiguity: { final_score: 0.19, threshold_met: true, override: null, rounds: 1 },
      codebaseSkipped: true,
    });

    assert.equal(b.artifacts.codebase_analysis.skipped, true);
    assert.equal(b.artifacts.codebase_analysis.sha256, null);
  });

  it('records override when present', () => {
    const b = buildBaseline(dir, {
      pipelineId: 'mpl-override',
      userRequest: 'x',
      accumulatedResponses: '',
      ambiguity: {
        final_score: 0.35, threshold_met: false, rounds: 5,
        override: { active: true, reason: 'stagnated', by: 'user_halt' }
      },
      codebaseSkipped: true,
    });
    assert.equal(b.ambiguity.override.active, true);
    assert.equal(b.ambiguity.override.reason, 'stagnated');
  });
});

describe('serializeBaseline', () => {
  it('produces YAML-ish output with all sections', () => {
    const b = {
      created_at: '2026-04-22T00:00:00.000Z',
      pipeline_id: 'mpl-x',
      git: { base_sha: 'abc123', base_branch: 'main', working_tree_clean: true },
      artifacts: {
        pivot_points: { path: '.mpl/pivot-points.md', sha256: 'h1' },
        core_scenarios: null,
        design_intent: null,
        user_contract: null,
        codebase_analysis: { path: '.mpl/mpl/codebase-analysis.json', sha256: null, skipped: true },
        raw_scan: null,
      },
      ambiguity: { final_score: 0.18, threshold_met: true, override: null, rounds: 3 },
      spec: { user_request_hash: 'req-h', resolved_spec_hash: 'res-h' },
    };

    const yaml = serializeBaseline(b);
    assert.ok(yaml.includes('pipeline_id: "mpl-x"'));
    assert.ok(yaml.includes('base_sha: "abc123"'));
    assert.ok(yaml.includes('working_tree_clean: true'));
    assert.ok(yaml.includes('pivot_points:'));
    assert.ok(yaml.includes('skipped: true'));
    assert.ok(yaml.includes('final_score: 0.18'));
    assert.ok(yaml.includes('user_request_hash: "req-h"'));
  });
});

describe('writeBaseline + baselineExists + renewalAuthorized', () => {
  let dir;
  beforeEach(() => { dir = createTempRepo(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes file and reports existence', () => {
    assert.equal(baselineExists(dir), false);

    const b = buildBaseline(dir, {
      pipelineId: 'mpl-write',
      userRequest: 'x', accumulatedResponses: '',
      ambiguity: { final_score: 0.1, threshold_met: true, override: null, rounds: 1 },
      codebaseSkipped: true,
    });
    writeBaseline(dir, b);

    assert.equal(baselineExists(dir), true);
    const written = readFileSync(join(dir, BASELINE_FILE), 'utf-8');
    assert.ok(written.includes('pipeline_id: "mpl-write"'));
  });

  it('renewalAuthorized toggles on sentinel presence', () => {
    assert.equal(renewalAuthorized(dir), false);
    mkdirSync(join(dir, '.mpl/mpl'), { recursive: true });
    writeFileSync(join(dir, RENEWAL_FLAG_FILE), '');
    assert.equal(renewalAuthorized(dir), true);
  });
});
