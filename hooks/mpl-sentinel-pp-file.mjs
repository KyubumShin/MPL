#!/usr/bin/env node
/**
 * MPL Sentinel PP-File — Pivot Point File Modification Detector (PostToolUse)
 *
 * Watches Edit/Write operations and checks if the modified file is referenced
 * by any active Pivot Point in .mpl/pivot-points.md. On match, injects
 * additionalContext so the Phase Runner knows it's touching PP-constrained code.
 *
 * Non-blocking: never sets exitCode 2. PP compliance checking belongs to the
 * Runner's self-check and Hard 3, not a hook veto.
 *
 * AD-04 (v0.13.0): L1 "defend at the keystroke" defense layer.
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync, statSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

let ppCache = null;
let ppCacheMtime = null;

/**
 * Parse pivot-points.md and extract file references per PP.
 * Returns array of { pp_id, constraint, patterns: string[] }.
 */
export function parsePivotPoints(content) {
  if (!content) return [];

  const results = [];
  const ppBlocks = content.split(/(?=^##\s+PP-)/m);

  for (const block of ppBlocks) {
    const headerMatch = block.match(/^##\s+(PP-\d+):\s*(.+)/m);
    if (!headerMatch) continue;

    const pp_id = headerMatch[1];
    const constraint = headerMatch[2].trim();

    const patterns = [];
    const fileRefs = block.matchAll(/`([^`]+\.[a-zA-Z]{1,10})`/g);
    for (const m of fileRefs) {
      patterns.push(m[1]);
    }

    const pathRefs = block.matchAll(/(?:src|lib|app|hooks|commands|agents|prompts)\/[\w./\-*]+/g);
    for (const m of pathRefs) {
      if (!patterns.includes(m[0])) {
        patterns.push(m[0]);
      }
    }

    if (patterns.length > 0) {
      results.push({ pp_id, constraint, patterns });
    }
  }

  return results;
}

/**
 * Check if a file path matches any PP pattern.
 * Supports literal path match and simple glob (* wildcard).
 */
export function matchFileToPP(filePath, ppEntries) {
  const matches = [];
  const normalized = filePath.replace(/\\/g, '/');

  for (const entry of ppEntries) {
    for (const pattern of entry.patterns) {
      const normalizedPattern = pattern.replace(/\\/g, '/');

      if (normalizedPattern.includes('*')) {
        const regex = new RegExp(
          '^' + normalizedPattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
        );
        if (regex.test(normalized) || normalized.endsWith(normalizedPattern.replace(/\*/g, ''))) {
          matches.push(entry);
          break;
        }
      } else {
        if (normalized.endsWith(normalizedPattern) || normalized.includes(normalizedPattern)) {
          matches.push(entry);
          break;
        }
      }
    }
  }

  return matches;
}

function loadPPWithCache(cwd) {
  const ppPath = resolve(cwd, '.mpl/pivot-points.md');
  if (!existsSync(ppPath)) return [];

  const stat = statSync(ppPath);
  const mtime = stat.mtimeMs;

  if (ppCache && ppCacheMtime === mtime) {
    return ppCache;
  }

  const content = readFileSync(ppPath, 'utf-8');
  ppCache = parsePivotPoints(content);
  ppCacheMtime = mtime;
  return ppCache;
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolName = data.tool_name || data.toolName || '';

  if (!['Edit', 'edit', 'Write', 'write'].includes(toolName)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const filePath = toolInput.file_path || toolInput.filePath || '';
  if (!filePath) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const ppEntries = loadPPWithCache(cwd);
  if (ppEntries.length === 0) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const matches = matchFileToPP(filePath, ppEntries);
  if (matches.length === 0) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const ppNotices = matches.map(m =>
    `⚠️ ${m.pp_id}: "${m.constraint}" — this file is PP-constrained. Verify your edit satisfies the Pivot Point before proceeding.`
  ).join('\n');

  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    additionalContext: `[MPL Sentinel PP-File] The file you just modified is referenced by active Pivot Point(s):\n${ppNotices}`
  }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
