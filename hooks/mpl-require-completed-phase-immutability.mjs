#!/usr/bin/env node
/**
 * MPL Require Completed Phase Immutability Hook (PreToolUse Write|Edit|MultiEdit).
 *
 * Blocks recomposition from mutating phase blocks that already have completion
 * evidence. Later phases can still be appended or edited through the delta flow.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const {
  completedPhaseIds,
  validateCompletedPhaseImmutability,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-completed-phase-immutability.mjs')).href
);
const { collectFileWrites, isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
}

export function targetsDecompositionFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(filePath);
}

function isFullWriteTool(toolName) {
  return ['Write', 'write'].includes(String(toolName || ''));
}

function currentDecompositionPath(cwd) {
  return join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) return ok();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const cfg = loadConfig(cwd);
  if (cfg.completed_phase_immutability_required === false) return ok();

  const existingPath = currentDecompositionPath(cwd);
  if (!existsSync(existingPath)) return ok();

  const state = readState(cwd) || {};
  const completedIds = completedPhaseIds(cwd, state);
  if (completedIds.length === 0) return ok();

  const oldText = readFileSync(existingPath, 'utf-8');
  const issues = [];
  const toolInput = data.tool_input || data.toolInput || {};
  for (const entry of collectFileWrites(toolInput)) {
    if (!targetsDecompositionFile(entry.filePath)) continue;
    if (!isFullWriteTool(toolName)) {
      issues.push('decomposition:partial_edit_not_allowed_with_completed_phases');
      continue;
    }
    if (!entry.text || !String(entry.text).trim()) {
      issues.push('decomposition:empty_write');
      continue;
    }
    const verdict = validateCompletedPhaseImmutability({
      oldText,
      newText: entry.text,
      completedIds,
    });
    issues.push(...verdict.issues);
  }

  if (issues.length > 0) {
    const shown = issues.slice(0, 12).join(', ');
    const more = issues.length > 12 ? ` (+${issues.length - 12} more)` : '';
    block(
      `[MPL Completed Phase Immutability] Completed phase contract blocks are immutable during recomposition: ` +
        `${shown}${more}. Append new phases or modify only incomplete phases.`
    );
    return;
  }

  ok();
}

if (isMain) {
  await main().catch(() => ok());
}
