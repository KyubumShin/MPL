#!/usr/bin/env node
/**
 * MPL 4-Tier Adaptive Memory (F-25)
 *
 * 4-tier memory management utility:
 *   episodic.md       — Phase completion summaries (time-based compression)
 *   semantic.md        — Generalization of patterns repeated 3+ times (project knowledge)
 *   procedural.jsonl   — Tool usage patterns (with classification tags)
 *   working.md         — Current Phase TODO (ephemeral, active execution only)
 *
 * Memory directory: .mpl/memory/
 */

import { readFile, writeFile, mkdir, rename, stat } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';

const MEMORY_DIR = '.mpl/memory';
const EPISODIC_FILE = 'episodic.md';
const SEMANTIC_FILE = 'semantic.md';
const PROCEDURAL_FILE = 'procedural.jsonl';
const WORKING_FILE = 'working.md';

// ──────────────────────────────────────
// Helpers
// ──────────────────────────────────────

/**
 * Atomic write: temp file → rename
 * @param {string} filePath - Target file path
 * @param {string} content  - Content to write
 */
async function atomicWrite(filePath, content) {
  const dir = join(filePath, '..');
  const tmp = join(dir, `.tmp-${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, filePath);
}

/**
 * Safe read: returns empty string if file missing
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function safeRead(filePath) {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Check if file exists
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────
// Directory
// ──────────────────────────────────────

/**
 * Create .mpl/memory/ directory if it does not exist
 * @param {string} cwd - Working directory
 */
export async function ensureMemoryDir(cwd) {
  const dir = join(cwd, MEMORY_DIR);
  await mkdir(dir, { recursive: true });
}

// ──────────────────────────────────────
// Episodic Memory
// ──────────────────────────────────────

/**
 * Read episodic.md — returns array of parsed sections
 * @param {string} cwd
 * @returns {Promise<Array<{phase: string, name: string, timestamp: string, body: string}>>}
 */
export async function readEpisodicMemory(cwd) {
  const content = await safeRead(join(cwd, MEMORY_DIR, EPISODIC_FILE));
  if (!content.trim()) return [];

  const sections = [];
  // ### Phase N: {name} ({timestamp})
  const regex = /^### Phase (\S+): (.+?) \(([^)]+)\)\s*$/gm;
  let match;
  const matches = [];

  while ((match = regex.exec(content)) !== null) {
    matches.push({
      phase: match[1],
      name: match[2],
      timestamp: match[3],
      startIdx: match.index,
      headerEnd: match.index + match[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const bodyStart = m.headerEnd;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].startIdx : content.length;
    sections.push({
      phase: m.phase,
      name: m.name,
      timestamp: m.timestamp,
      body: content.slice(bodyStart, bodyEnd).trim(),
    });
  }

  return sections;
}

/**
 * Append a Phase completion summary to episodic.md
 * @param {string} cwd
 * @param {string} phaseId - e.g. "1", "2", "0"
 * @param {string} summary - 2-3 line summary
 */
export async function appendEpisodic(cwd, phaseId, summary) {
  await ensureMemoryDir(cwd);
  const filePath = join(cwd, MEMORY_DIR, EPISODIC_FILE);
  const existing = await safeRead(filePath);
  const timestamp = new Date().toISOString();
  const entry = `### Phase ${phaseId}: ${summary.split('\n')[0]} (${timestamp})\n${summary}\n\n`;
  await atomicWrite(filePath, existing + entry);
}

/**
 * Time-based compression: keep last N Phases in detail, compress earlier ones to 1 line
 * @param {string} cwd
 * @param {number} keepDetailedCount - Number of recent Phases to keep in detail (default 2)
 */
export async function compressEpisodic(cwd, keepDetailedCount = 5) {
  const sections = await readEpisodicMemory(cwd);
  if (sections.length <= keepDetailedCount) return;

  const compressed = [];
  const cutoff = sections.length - keepDetailedCount;

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (i < cutoff) {
      // Compress to 1 line
      const oneLine = s.body.split('\n').filter(l => l.trim()).slice(0, 1).join(' ').slice(0, 120);
      compressed.push(`- Phase ${s.phase}: ${s.name} — ${oneLine}`);
    } else {
      // Keep in detail
      compressed.push(`### Phase ${s.phase}: ${s.name} (${s.timestamp})\n${s.body}`);
    }
  }

  // Enforce 100-line upper limit
  let output = compressed.join('\n\n') + '\n';
  const lines = output.split('\n');
  if (lines.length > 100) {
    output = lines.slice(lines.length - 100).join('\n');
  }

  const filePath = join(cwd, MEMORY_DIR, EPISODIC_FILE);
  await atomicWrite(filePath, output);
}

// ──────────────────────────────────────
// Semantic Memory
// ──────────────────────────────────────

/**
 * Read semantic.md (generalized project knowledge)
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function readSemanticMemory(cwd) {
  return await safeRead(join(cwd, MEMORY_DIR, SEMANTIC_FILE));
}

/**
 * Promote a repeated pattern to semantic.md
 * @param {string} cwd
 * @param {string} pattern - Pattern description
 * @param {string} category - Category: "Failure Patterns" | "Success Patterns" | "Project Conventions"
 */
export async function promoteToSemantic(cwd, pattern, category) {
  await ensureMemoryDir(cwd);
  const filePath = join(cwd, MEMORY_DIR, SEMANTIC_FILE);
  const existing = await safeRead(filePath);
  const header = `## ${category}`;
  const entry = `- ${pattern}`;

  if (existing.includes(header)) {
    // Append to existing category
    const updated = existing.replace(header, `${header}\n${entry}`);
    await atomicWrite(filePath, updated);
  } else {
    // Create new category
    const addition = `\n${header}\n${entry}\n`;
    await atomicWrite(filePath, existing + addition);
  }
}

/**
 * Detect patterns repeated 3+ times from episodic memory
 * @param {string} cwd
 * @param {number} threshold - Repetition count threshold (default 3)
 * @returns {Promise<Array<{keyword: string, count: number, category: string}>>}
 */
export async function detectRepeatedPatterns(cwd, threshold = 3) {
  const sections = await readEpisodicMemory(cwd);
  if (sections.length < threshold) return [];

  // Calculate keyword/tag frequency
  const freq = {};
  const categoryMap = {};

  for (const s of sections) {
    const text = `${s.name} ${s.body}`.toLowerCase();
    // Extract meaningful keywords (4+ characters)
    const words = text.match(/[a-z가-힣]{4,}/g) || [];
    const seen = new Set();

    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      freq[w] = (freq[w] || 0) + 1;

      // Infer category
      if (text.includes('fail') || text.includes('error') || text.includes('failure')) {
        categoryMap[w] = 'Failure Patterns';
      } else if (text.includes('success') || text.includes('pass') || text.includes('succeeded')) {
        categoryMap[w] = 'Success Patterns';
      } else {
        categoryMap[w] = 'Project Conventions';
      }
    }
  }

  // Return patterns repeated at or above threshold
  return Object.entries(freq)
    .filter(([, count]) => count >= threshold)
    .map(([keyword, count]) => ({
      keyword,
      count,
      category: categoryMap[keyword] || 'Project Conventions',
    }))
    .sort((a, b) => b.count - a.count);
}

// ──────────────────────────────────────
// Procedural Memory
// ──────────────────────────────────────

/**
 * Read procedural.jsonl — returns array of parsed entries
 * @param {string} cwd
 * @returns {Promise<Array<object>>}
 */
export async function readProcedural(cwd) {
  const content = await safeRead(join(cwd, MEMORY_DIR, PROCEDURAL_FILE));
  if (!content.trim()) return [];

  return content
    .trim()
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Append a tool usage pattern entry
 * @param {string} cwd
 * @param {object} entry - {timestamp, phase, tool, action, result, tags[], context}
 */
export async function appendProcedural(cwd, entry) {
  await ensureMemoryDir(cwd);
  const filePath = join(cwd, MEMORY_DIR, PROCEDURAL_FILE);
  const existing = await safeRead(filePath);

  const record = {
    timestamp: entry.timestamp || new Date().toISOString(),
    phase: entry.phase || null,
    tool: entry.tool || null,
    action: entry.action || null,
    result: entry.result || null,
    tags: entry.tags || [],
    context: entry.context || null,
  };

  const line = JSON.stringify(record) + '\n';
  const updated = existing + line;

  // 100-entry upper limit: evict excess via FIFO
  const lines = updated.trim().split('\n').filter(l => l.trim());
  const trimmed = lines.length > 100 ? lines.slice(lines.length - 100) : lines;

  await atomicWrite(filePath, trimmed.join('\n') + '\n');
}

/**
 * Tag-based lookup — returns most relevant entries
 * @param {string} cwd
 * @param {string[]} tags - Tags to search for
 * @param {number} limit  - Maximum entries to return (default 10)
 * @returns {Promise<Array<object>>}
 */
export async function queryProcedural(cwd, tags, limit = 10) {
  const entries = await readProcedural(cwd);
  if (!tags || tags.length === 0) return entries.slice(-limit);

  const tagSet = new Set(tags.map(t => t.toLowerCase()));

  // Calculate tag match score, then sort
  const scored = entries.map(entry => {
    const entryTags = (entry.tags || []).map(t => t.toLowerCase());
    const matchCount = entryTags.filter(t => tagSet.has(t)).length;
    return { entry, score: matchCount };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.entry);
}

// ──────────────────────────────────────
// Working Memory
// ──────────────────────────────────────

/**
 * Read working.md (current Phase state)
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function readWorkingMemory(cwd) {
  return await safeRead(join(cwd, MEMORY_DIR, WORKING_FILE));
}

/**
 * Update working.md — overwrite current Phase TODO state
 * @param {string} cwd
 * @param {string} content
 */
export async function updateWorkingMemory(cwd, content) {
  await ensureMemoryDir(cwd);
  const filePath = join(cwd, MEMORY_DIR, WORKING_FILE);
  await atomicWrite(filePath, content);
}

/**
 * Clear working.md — cleanup on Phase completion
 * @param {string} cwd
 */
export async function clearWorkingMemory(cwd) {
  await ensureMemoryDir(cwd);
  const filePath = join(cwd, MEMORY_DIR, WORKING_FILE);
  await atomicWrite(filePath, '');
}

// ──────────────────────────────────────
// Selective Loading (for Phase 0)
// ──────────────────────────────────────

/**
 * Selectively load task-relevant memory (within token budget)
 *
 * Priority:
 *   1. semantic.md (generalized knowledge, small size)
 *   2. procedural entries (tag matching)
 *   3. episodic last 2 (detailed)
 *   4. working.md excluded (current execution only)
 *
 * @param {string} cwd
 * @param {string} taskDescription - Task description (used for tag extraction)
 * @param {number} maxTokens - Token budget (default 2000, ~4chars/token)
 * @returns {Promise<{semantic: string, procedural: object[], episodic: string, totalChars: number}>}
 */
export async function loadRelevantMemory(cwd, taskDescription, maxTokens = 2000) {
  const charBudget = maxTokens * 4; // Approximate token-to-character conversion
  let remaining = charBudget;

  // 1. Semantic (always load)
  let semantic = await readSemanticMemory(cwd);
  if (semantic.length > remaining * 0.4) {
    semantic = semantic.slice(0, Math.floor(remaining * 0.4));
  }
  remaining -= semantic.length;

  // 2. Procedural (tag matching)
  const taskTags = extractTags(taskDescription);
  const proceduralEntries = await queryProcedural(cwd, taskTags, 5);
  let proceduralText = proceduralEntries.map(e => JSON.stringify(e)).join('\n');
  if (proceduralText.length > remaining * 0.3) {
    proceduralText = proceduralText.slice(0, Math.floor(remaining * 0.3));
  }
  remaining -= proceduralText.length;

  // 3. Episodic (last 2 in detail)
  const sections = await readEpisodicMemory(cwd);
  const recentSections = sections.slice(-5);
  let episodic = recentSections
    .map(s => `### Phase ${s.phase}: ${s.name} (${s.timestamp})\n${s.body}`)
    .join('\n\n');
  if (episodic.length > remaining) {
    episodic = episodic.slice(0, remaining);
  }

  const totalChars = semantic.length + proceduralText.length + episodic.length;

  return {
    semantic,
    procedural: proceduralEntries,
    episodic,
    totalChars,
  };
}

/**
 * Extract tags from task description (simple keyword approach)
 * @param {string} text
 * @returns {string[]}
 */
function extractTags(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  // Match against known tag patterns
  const knownTags = [
    'type_mismatch', 'dependency_conflict', 'test_flake',
    'api_contract_violation', 'build_failure', 'lint_error',
    'runtime_error', 'performance', 'security', 'refactor',
    'migration', 'test', 'debug', 'config',
  ];
  const matched = knownTags.filter(tag =>
    lower.includes(tag) || lower.includes(tag.replace(/_/g, ' '))
  );

  // Also include words with 4+ characters
  const words = lower.match(/[a-z]{4,}/g) || [];
  const extra = words.filter(w => !['this', 'that', 'with', 'from', 'have', 'been'].includes(w));

  return [...new Set([...matched, ...extra.slice(0, 5)])];
}

// ──────────────────────────────────────
// Statistics
// ──────────────────────────────────────

/**
 * Return memory statistics
 * @param {string} cwd
 * @returns {Promise<{episodic_entries: number, semantic_rules: number, procedural_entries: number, working_active: boolean}>}
 */
export async function getMemoryStats(cwd) {
  const episodic = await readEpisodicMemory(cwd);
  const semantic = await readSemanticMemory(cwd);
  const procedural = await readProcedural(cwd);
  const working = await readWorkingMemory(cwd);

  // semantic rules: count bullet item entries
  const semanticRules = (semantic.match(/^- .+/gm) || []).length;

  return {
    episodic_entries: episodic.length,
    semantic_rules: semanticRules,
    procedural_entries: procedural.length,
    working_active: working.trim().length > 0,
  };
}
