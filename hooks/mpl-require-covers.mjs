#!/usr/bin/env node
/**
 * MPL Require Covers Hook (PreToolUse on Write|Edit)
 *
 * Validates the Tier B schema on `.mpl/mpl/decomposition.yaml` writes:
 *   - Every phase MUST have non-empty `covers: [...]`.
 *   - Each entry MUST be either `internal` (escape) or match `UC-\d{2,}`.
 *   - Emits a warn (not block) when the ratio of `["internal"]`-only phases
 *     exceeds the configured threshold (default 0.4).
 *
 * Config: `.mpl/config.json` may set `internal_todo_warn_threshold` (0..1).
 *
 * Legacy graceful-skip mode: when `.mpl/requirements/user-contract.md` is
 * absent, the hook accepts `["internal"]` anywhere without checking UC-NN
 * existence, and only enforces the ratio warn.
 *
 * Non-blocking on any error.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_WARN_THRESHOLD = 0.4;
const UC_ID_RE = /^UC-\d{2,}$/;

export function targetsDecompositionFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition\.yaml$/.test(filePath);
}

/**
 * Minimal YAML parse: extract every phase's `id` and `covers` list.
 * Returns [{ id, covers: [string] }, ...]
 *
 * Handles:
 *   - `- id: "phase-1"` phase entry
 *   - `covers:` key on same or nested line, followed by list items or inline
 */
export function parsePhaseCovers(yamlText) {
  if (!yamlText || typeof yamlText !== 'string') return [];

  const lines = yamlText.split('\n').map((l) => l.replace(/\r$/, ''));
  const phases = [];
  let cur = null;
  let inCovers = false;
  let coversIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Phase start
    const phaseMatch = line.match(/^\s*-\s+id:\s*["']?(phase-[\w-]+)["']?/);
    if (phaseMatch) {
      if (cur) phases.push(cur);
      cur = { id: phaseMatch[1], covers: null }; // null = field missing
      inCovers = false;
      continue;
    }
    if (!cur) continue;

    // covers: inline array form: `covers: [UC-01, UC-02]` or `covers: ["internal"]`
    const inlineMatch = line.match(/^(\s*)covers\s*:\s*\[(.*)\]\s*$/);
    if (inlineMatch) {
      const items = inlineMatch[2]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      cur.covers = items;
      inCovers = false;
      continue;
    }

    // covers: start of nested list form
    const blockMatch = line.match(/^(\s*)covers\s*:\s*$/);
    if (blockMatch) {
      coversIndent = blockMatch[1].length;
      cur.covers = [];
      inCovers = true;
      continue;
    }

    if (inCovers) {
      // list item under covers: `  - "UC-01"` or `  - internal`
      const itemMatch = line.match(/^(\s*)-\s+["']?([^"'\s#]+)["']?/);
      if (itemMatch && itemMatch[1].length > coversIndent) {
        cur.covers.push(itemMatch[2]);
        continue;
      }
      // Non-item line with indent <= coversIndent = covers block ended
      if (line.trim() !== '' && !line.startsWith(' '.repeat(coversIndent + 1))) {
        inCovers = false;
      }
    }
  }

  if (cur) phases.push(cur);
  return phases;
}

export function validatePhase(phase, { allowLegacy }) {
  const issues = [];
  if (phase.covers === null) {
    issues.push({ kind: 'missing', phase: phase.id });
    return issues;
  }
  if (!Array.isArray(phase.covers) || phase.covers.length === 0) {
    issues.push({ kind: 'empty', phase: phase.id });
    return issues;
  }
  for (const entry of phase.covers) {
    if (entry === 'internal') continue;
    if (UC_ID_RE.test(entry)) continue;
    issues.push({ kind: 'invalid_entry', phase: phase.id, entry });
  }
  // legacy mode downgrades UC format errors to warns (allow `internal` everywhere)
  if (allowLegacy) {
    return issues.filter((i) => i.kind !== 'invalid_entry');
  }
  return issues;
}

export function computeInternalRatio(phases) {
  const total = phases.filter(
    (p) => Array.isArray(p.covers) && p.covers.length > 0,
  ).length;
  if (total === 0) return 0;
  const internalOnly = phases.filter(
    (p) =>
      Array.isArray(p.covers) &&
      p.covers.length > 0 &&
      p.covers.every((c) => c === 'internal'),
  ).length;
  return internalOnly / total;
}

export function loadWarnThreshold(cwd) {
  const path = join(cwd, '.mpl', 'config.json');
  if (!existsSync(path)) return DEFAULT_WARN_THRESHOLD;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8'));
    const t = cfg.internal_todo_warn_threshold;
    if (typeof t === 'number' && t > 0 && t <= 1) return t;
  } catch {
    // fall through
  }
  return DEFAULT_WARN_THRESHOLD;
}

export function isLegacyMode(cwd) {
  const path = join(cwd, '.mpl', 'requirements', 'user-contract.md');
  return !existsSync(path);
}

function extractProposedContent(toolInput, toolName) {
  if (!toolInput) return '';
  if (toolName === 'Write') return toolInput.content || '';
  if (toolName === 'Edit') return toolInput.new_string || '';
  return '';
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isMain) {
  const { readStdin } = await import(
    pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
  );

  const ok = () =>
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  const okWithWarn = (msg) =>
    console.log(
      JSON.stringify({
        continue: true,
        suppressOutput: false,
        systemMessage: msg,
      }),
    );
  const block = (reason) =>
    console.log(JSON.stringify({ continue: false, decision: 'block', reason }));

  try {
    const raw = await readStdin();
    if (!raw) { ok(); process.exit(0); }

    let input;
    try { input = JSON.parse(raw); } catch { ok(); process.exit(0); }

    const toolName = input.tool_name || '';
    if (toolName !== 'Write' && toolName !== 'Edit') { ok(); process.exit(0); }

    const toolInput = input.tool_input || {};
    const target = toolInput.file_path || '';
    if (!targetsDecompositionFile(target)) { ok(); process.exit(0); }

    const content = extractProposedContent(toolInput, toolName);
    if (!content) { ok(); process.exit(0); }

    const cwd = input.cwd || process.cwd();
    const legacy = isLegacyMode(cwd);
    const phases = parsePhaseCovers(content);

    if (phases.length === 0) { ok(); process.exit(0); }

    const allIssues = [];
    for (const p of phases) {
      const issues = validatePhase(p, { allowLegacy: legacy });
      allIssues.push(...issues);
    }
    if (allIssues.length > 0) {
      const summary = allIssues
        .slice(0, 10)
        .map((i) => {
          if (i.kind === 'missing')
            return `${i.phase}: covers field missing`;
          if (i.kind === 'empty')
            return `${i.phase}: covers is empty`;
          return `${i.phase}: invalid covers entry "${i.entry}" (must match UC-NN or "internal")`;
        })
        .join('; ');
      const more = allIssues.length > 10 ? ` (+${allIssues.length - 10} more)` : '';
      block(
        `Tier B schema violation in decomposition.yaml: ${summary}${more}. ` +
          `See docs/schemas/user-contract.md for UC ids.`,
      );
      process.exit(0);
    }

    // warn on internal ratio
    const threshold = loadWarnThreshold(cwd);
    const ratio = computeInternalRatio(phases);
    if (ratio > threshold) {
      okWithWarn(
        `[MPL Tier B] internal-only phases ${(ratio * 100).toFixed(0)}% > threshold ${(threshold * 100).toFixed(0)}%. ` +
          `Consider whether more phases could covers a user UC. Override via .mpl/config.json internal_todo_warn_threshold.`,
      );
    } else {
      ok();
    }
  } catch {
    ok();
  }
}
