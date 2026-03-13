#!/usr/bin/env node
/**
 * MPL 4-Tier Adaptive Memory (F-25)
 *
 * 4계층 메모리 관리 유틸리티:
 *   episodic.md       — Phase 완료 요약 (시간 기반 압축)
 *   semantic.md        — 3회+ 반복 패턴 일반화 (프로젝트 지식)
 *   procedural.jsonl   — 도구 사용 패턴 (분류 태그 포함)
 *   working.md         — 현재 Phase TODO (임시, 실행 중만)
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
 * .mpl/memory/ 디렉토리가 없으면 생성
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
 * episodic.md 읽기 — 파싱된 섹션 배열 반환
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
 * Phase 완료 요약을 episodic.md에 추가
 * @param {string} cwd
 * @param {string} phaseId - e.g. "1", "2", "0"
 * @param {string} summary - 2-3줄 요약
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
 * 시간 기반 압축: 최근 N Phase는 상세 유지, 이전은 1줄 압축
 * @param {string} cwd
 * @param {number} keepDetailedCount - 상세 유지할 최근 Phase 수 (기본 2)
 */
export async function compressEpisodic(cwd, keepDetailedCount = 2) {
  const sections = await readEpisodicMemory(cwd);
  if (sections.length <= keepDetailedCount) return;

  const compressed = [];
  const cutoff = sections.length - keepDetailedCount;

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (i < cutoff) {
      // 1줄 압축
      const oneLine = s.body.split('\n').filter(l => l.trim()).slice(0, 1).join(' ').slice(0, 120);
      compressed.push(`- Phase ${s.phase}: ${s.name} — ${oneLine}`);
    } else {
      // 상세 유지
      compressed.push(`### Phase ${s.phase}: ${s.name} (${s.timestamp})\n${s.body}`);
    }
  }

  // 100줄 상한 유지
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
 * semantic.md 읽기 (일반화된 프로젝트 지식)
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function readSemanticMemory(cwd) {
  return await safeRead(join(cwd, MEMORY_DIR, SEMANTIC_FILE));
}

/**
 * 반복 패턴을 semantic.md로 승격
 * @param {string} cwd
 * @param {string} pattern - 패턴 설명
 * @param {string} category - 카테고리: "Failure Patterns" | "Success Patterns" | "Project Conventions"
 */
export async function promoteToSemantic(cwd, pattern, category) {
  await ensureMemoryDir(cwd);
  const filePath = join(cwd, MEMORY_DIR, SEMANTIC_FILE);
  const existing = await safeRead(filePath);
  const header = `## ${category}`;
  const entry = `- ${pattern}`;

  if (existing.includes(header)) {
    // 기존 카테고리에 추가
    const updated = existing.replace(header, `${header}\n${entry}`);
    await atomicWrite(filePath, updated);
  } else {
    // 새 카테고리 생성
    const addition = `\n${header}\n${entry}\n`;
    await atomicWrite(filePath, existing + addition);
  }
}

/**
 * episodic에서 3회+ 반복 패턴 감지
 * @param {string} cwd
 * @param {number} threshold - 반복 횟수 임계값 (기본 3)
 * @returns {Promise<Array<{keyword: string, count: number, category: string}>>}
 */
export async function detectRepeatedPatterns(cwd, threshold = 3) {
  const sections = await readEpisodicMemory(cwd);
  if (sections.length < threshold) return [];

  // 키워드/태그 빈도 계산
  const freq = {};
  const categoryMap = {};

  for (const s of sections) {
    const text = `${s.name} ${s.body}`.toLowerCase();
    // 의미 있는 키워드 추출 (4글자 이상)
    const words = text.match(/[a-z가-힣]{4,}/g) || [];
    const seen = new Set();

    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      freq[w] = (freq[w] || 0) + 1;

      // 카테고리 추론
      if (text.includes('fail') || text.includes('error') || text.includes('실패')) {
        categoryMap[w] = 'Failure Patterns';
      } else if (text.includes('success') || text.includes('pass') || text.includes('성공')) {
        categoryMap[w] = 'Success Patterns';
      } else {
        categoryMap[w] = 'Project Conventions';
      }
    }
  }

  // threshold 이상 반복된 패턴 반환
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
 * procedural.jsonl 읽기 — 파싱된 엔트리 배열 반환
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
 * 도구 사용 패턴 엔트리 추가
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

  // 100 entries 상한: FIFO 초과 삭제
  const lines = updated.trim().split('\n').filter(l => l.trim());
  const trimmed = lines.length > 100 ? lines.slice(lines.length - 100) : lines;

  await atomicWrite(filePath, trimmed.join('\n') + '\n');
}

/**
 * 태그 기반 조회 — 관련도 높은 엔트리 반환
 * @param {string} cwd
 * @param {string[]} tags - 검색할 태그
 * @param {number} limit  - 최대 반환 수 (기본 10)
 * @returns {Promise<Array<object>>}
 */
export async function queryProcedural(cwd, tags, limit = 10) {
  const entries = await readProcedural(cwd);
  if (!tags || tags.length === 0) return entries.slice(-limit);

  const tagSet = new Set(tags.map(t => t.toLowerCase()));

  // 태그 매칭 점수 계산 후 정렬
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
 * working.md 읽기 (현재 Phase 상태)
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function readWorkingMemory(cwd) {
  return await safeRead(join(cwd, MEMORY_DIR, WORKING_FILE));
}

/**
 * working.md 갱신 — 현재 Phase TODO 상태 덮어쓰기
 * @param {string} cwd
 * @param {string} content
 */
export async function updateWorkingMemory(cwd, content) {
  await ensureMemoryDir(cwd);
  const filePath = join(cwd, MEMORY_DIR, WORKING_FILE);
  await atomicWrite(filePath, content);
}

/**
 * working.md 비우기 — Phase 완료 시 정리
 * @param {string} cwd
 */
export async function clearWorkingMemory(cwd) {
  await ensureMemoryDir(cwd);
  const filePath = join(cwd, MEMORY_DIR, WORKING_FILE);
  await atomicWrite(filePath, '');
}

// ──────────────────────────────────────
// Selective Loading (Phase 0 용)
// ──────────────────────────────────────

/**
 * 태스크 관련 메모리를 선택적으로 로드 (토큰 예산 내)
 *
 * 우선순위:
 *   1. semantic.md (일반화 지식, 작은 크기)
 *   2. procedural entries (태그 매칭)
 *   3. episodic 최근 2개 (상세)
 *   4. working.md 제외 (현재 실행 전용)
 *
 * @param {string} cwd
 * @param {string} taskDescription - 태스크 설명 (태그 추출용)
 * @param {number} maxTokens - 토큰 예산 (기본 2000, ~4chars/token)
 * @returns {Promise<{semantic: string, procedural: object[], episodic: string, totalChars: number}>}
 */
export async function loadRelevantMemory(cwd, taskDescription, maxTokens = 2000) {
  const charBudget = maxTokens * 4; // 대략적 토큰→문자 변환
  let remaining = charBudget;

  // 1. Semantic (항상 로드)
  let semantic = await readSemanticMemory(cwd);
  if (semantic.length > remaining * 0.4) {
    semantic = semantic.slice(0, Math.floor(remaining * 0.4));
  }
  remaining -= semantic.length;

  // 2. Procedural (태그 매칭)
  const taskTags = extractTags(taskDescription);
  const proceduralEntries = await queryProcedural(cwd, taskTags, 5);
  let proceduralText = proceduralEntries.map(e => JSON.stringify(e)).join('\n');
  if (proceduralText.length > remaining * 0.3) {
    proceduralText = proceduralText.slice(0, Math.floor(remaining * 0.3));
  }
  remaining -= proceduralText.length;

  // 3. Episodic (최근 2개 상세)
  const sections = await readEpisodicMemory(cwd);
  const recentSections = sections.slice(-2);
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
 * 태스크 설명에서 태그 추출 (간단한 키워드 방식)
 * @param {string} text
 * @returns {string[]}
 */
function extractTags(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  // 알려진 태그 패턴 매칭
  const knownTags = [
    'type_mismatch', 'dependency_conflict', 'test_flake',
    'api_contract_violation', 'build_failure', 'lint_error',
    'runtime_error', 'performance', 'security', 'refactor',
    'migration', 'test', 'debug', 'config',
  ];
  const matched = knownTags.filter(tag =>
    lower.includes(tag) || lower.includes(tag.replace(/_/g, ' '))
  );

  // 4글자 이상 단어도 추가
  const words = lower.match(/[a-z]{4,}/g) || [];
  const extra = words.filter(w => !['this', 'that', 'with', 'from', 'have', 'been'].includes(w));

  return [...new Set([...matched, ...extra.slice(0, 5)])];
}

// ──────────────────────────────────────
// Statistics
// ──────────────────────────────────────

/**
 * 메모리 통계 반환
 * @param {string} cwd
 * @returns {Promise<{episodic_entries: number, semantic_rules: number, procedural_entries: number, working_active: boolean}>}
 */
export async function getMemoryStats(cwd) {
  const episodic = await readEpisodicMemory(cwd);
  const semantic = await readSemanticMemory(cwd);
  const procedural = await readProcedural(cwd);
  const working = await readWorkingMemory(cwd);

  // semantic rules: bullet 항목 수 계산
  const semanticRules = (semantic.match(/^- .+/gm) || []).length;

  return {
    episodic_entries: episodic.length,
    semantic_rules: semanticRules,
    procedural_entries: procedural.length,
    working_active: working.trim().length > 0,
  };
}
