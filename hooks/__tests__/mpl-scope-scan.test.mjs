import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculatePipelineScore,
  classifyProximity,
  extractRiskSignal,
} from '../lib/mpl-scope-scan.mjs';

const SCAN = {
  affected_files: 5,
  test_scenarios: 4,
  import_depth: 3,
  risk_signal: 0.5,
};

describe('calculatePipelineScore', () => {
  it('should compute score with default weights', () => {
    const result = calculatePipelineScore(SCAN);
    // file_scope = 5/10 = 0.5, test = 4/8 = 0.5, depth = 3/5 = 0.6, risk = 0.5
    // 0.5*0.35 + 0.5*0.25 + 0.6*0.25 + 0.5*0.15 = 0.175 + 0.125 + 0.15 + 0.075 = 0.525
    assert.strictEqual(result.score, 0.525);
  });

  it('should accept custom weights', () => {
    const weights = { file_scope: 0.10, test_complexity: 0.10, dependency_depth: 0.10, risk_signal: 0.70 };
    const result = calculatePipelineScore(SCAN, weights);
    // 0.5*0.10 + 0.5*0.10 + 0.6*0.10 + 0.5*0.70 = 0.05 + 0.05 + 0.06 + 0.35 = 0.51
    assert.strictEqual(result.score, 0.51);
  });

  it('should normalize weights that do not sum to 1.0', () => {
    const weights = { file_scope: 1, test_complexity: 1, dependency_depth: 1, risk_signal: 1 };
    // All equal weights (each 0.25 after normalization) → same as equal weighting
    const result = calculatePipelineScore(SCAN, weights);
    // 0.5*0.25 + 0.5*0.25 + 0.6*0.25 + 0.5*0.25 = 0.125+0.125+0.15+0.125 = 0.525
    assert.strictEqual(result.score, 0.525);
  });

  it('should use defaults for missing weight keys', () => {
    // Partial weights — only override file_scope
    const weights = { file_scope: 0.55 };
    const result = calculatePipelineScore(SCAN, weights);
    // Total = 0.55 + 0.25 + 0.25 + 0.15 = 1.20 → normalized
    // Normalized: 0.458, 0.208, 0.208, 0.125
    assert.ok(result.score > 0 && result.score < 1);
  });

  it('should return same result with null weights as with no weights', () => {
    const a = calculatePipelineScore(SCAN, null);
    const b = calculatePipelineScore(SCAN);
    assert.strictEqual(a.score, b.score);
  });

  it('should handle zero scan values', () => {
    const result = calculatePipelineScore({ affected_files: 0, test_scenarios: 0, import_depth: 0, risk_signal: 0 });
    assert.strictEqual(result.score, 0);
  });
});

describe('classifyProximity', () => {
  it('should classify near for low score', () => {
    assert.strictEqual(classifyProximity(0.2).proximity, 'near');
  });

  it('should classify mid for medium score', () => {
    assert.strictEqual(classifyProximity(0.5).proximity, 'mid');
  });

  it('should classify far for high score', () => {
    assert.strictEqual(classifyProximity(0.8).proximity, 'far');
  });

  it('should respect hint override', () => {
    const result = classifyProximity(0.8, 'near');
    assert.strictEqual(result.proximity, 'near');
    assert.strictEqual(result.source, 'hint');
  });
});

describe('extractRiskSignal', () => {
  it('should detect low risk keywords', () => {
    assert.strictEqual(extractRiskSignal('fix the bug'), 0.1);
  });

  it('should detect high risk keywords', () => {
    assert.strictEqual(extractRiskSignal('refactor the auth module'), 0.8);
  });

  it('should return default for unknown text', () => {
    assert.strictEqual(extractRiskSignal('do something'), 0.4);
  });
});
