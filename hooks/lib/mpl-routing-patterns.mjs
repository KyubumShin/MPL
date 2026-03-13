#!/usr/bin/env node
/**
 * MPL Routing Pattern Learning (F-22)
 *
 * Records execution results and matches similar past patterns
 * to improve tier prediction in future Triage runs.
 *
 * File: .mpl/memory/routing-patterns.jsonl (append-only)
 * Reference: Ouroboros DowngradeManager (Jaccard similarity)
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const MEMORY_DIR = '.mpl/memory';
const PATTERNS_FILE = 'routing-patterns.jsonl';

/**
 * Tokenize a description string for Jaccard comparison
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
  );
}

/**
 * Calculate Jaccard similarity between two strings
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity (0.0~1.0)
 */
export function jaccardSimilarity(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Append a routing pattern after execution completes
 * @param {string} cwd - Working directory
 * @param {object} pattern
 * @param {string} pattern.description - Task description (user prompt summary)
 * @param {string} pattern.tier - Final pipeline_tier
 * @param {string|null} pattern.escalated_from - Original tier if escalated, null otherwise
 * @param {string} pattern.result - "success" | "partial" | "failed"
 * @param {number} pattern.tokens - Estimated total tokens used
 * @param {number} pattern.files - Number of affected files
 * @param {object} [pattern.domain_distribution] - Optional distribution of work across domains (e.g. { frontend: 0.4, backend: 0.6 })
 */
export function appendPattern(cwd, pattern) {
  const dir = join(cwd, MEMORY_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const entry = {
    ts: new Date().toISOString(),
    desc: pattern.description,
    tier: pattern.tier,
    ...(pattern.escalated_from ? { escalated_from: pattern.escalated_from } : {}),
    result: pattern.result,
    tokens: pattern.tokens || 0,
    files: pattern.files || 0,
    ...(pattern.domain_distribution ? { domain_distribution: pattern.domain_distribution } : {}),
  };

  const filePath = join(dir, PATTERNS_FILE);
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  return entry;
}

/**
 * Find similar past patterns for tier recommendation
 * @param {string} cwd - Working directory
 * @param {string} description - Current task description
 * @param {number} threshold - Jaccard similarity threshold (default 0.8)
 * @returns {{ match: object|null, similarity: number, recommendation: string|null }}
 */
export function findSimilarPattern(cwd, description, threshold = 0.8) {
  const filePath = join(cwd, MEMORY_DIR, PATTERNS_FILE);
  if (!existsSync(filePath)) {
    return { match: null, similarity: 0, recommendation: null };
  }

  let patterns;
  try {
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    patterns = lines.map(line => JSON.parse(line));
  } catch {
    return { match: null, similarity: 0, recommendation: null };
  }

  let bestMatch = null;
  let bestSimilarity = 0;

  for (const pattern of patterns) {
    const sim = jaccardSimilarity(description, pattern.desc);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestMatch = pattern;
    }
  }

  if (bestSimilarity >= threshold && bestMatch) {
    // If the past pattern was escalated, recommend the escalated tier
    const recommendedTier = bestMatch.escalated_from ? bestMatch.escalated_from : bestMatch.tier;
    return {
      match: bestMatch,
      similarity: Math.round(bestSimilarity * 1000) / 1000,
      recommendation: recommendedTier,
    };
  }

  return { match: bestMatch, similarity: Math.round(bestSimilarity * 1000) / 1000, recommendation: null };
}

/**
 * Get pattern stats for diagnostics
 * @param {string} cwd
 * @returns {{ total: number, by_tier: object, by_result: object }}
 */
export function getPatternStats(cwd) {
  const filePath = join(cwd, MEMORY_DIR, PATTERNS_FILE);
  if (!existsSync(filePath)) {
    return { total: 0, by_tier: {}, by_result: {} };
  }

  try {
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const patterns = lines.map(line => JSON.parse(line));

    const byTier = {};
    const byResult = {};
    for (const p of patterns) {
      byTier[p.tier] = (byTier[p.tier] || 0) + 1;
      byResult[p.result] = (byResult[p.result] || 0) + 1;
    }

    return { total: patterns.length, by_tier: byTier, by_result: byResult };
  } catch {
    return { total: 0, by_tier: {}, by_result: {} };
  }
}
