/**
 * Completed phase immutability helpers.
 *
 * Once a phase has completed evidence, recomposition may append or adjust later
 * phases but must not mutate the completed phase contract block.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

function phaseBlocks(text) {
  const blocks = new Map();
  let cur = null;

  const flush = () => {
    if (cur) blocks.set(cur.id, normalizePhaseBlock(cur.text));
    cur = null;
  };

  for (const line of String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))) {
    const idMatch = line.match(/^\s*-\s+id:\s*["']?(phase-[\w.-]+)["']?/);
    if (idMatch) {
      flush();
      cur = { id: idMatch[1], text: `${line}\n` };
      continue;
    }
    if (cur) cur.text += `${line}\n`;
  }
  flush();
  return blocks;
}

export function normalizePhaseBlock(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function diskCompletedPhaseIds(cwd) {
  const phasesDir = join(cwd, '.mpl', 'mpl', 'phases');
  if (!existsSync(phasesDir)) return [];
  const out = [];
  try {
    for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^phase-[\w.-]+$/.test(entry.name)) continue;
      if (existsSync(join(phasesDir, entry.name, 'state-summary.md'))) {
        out.push(entry.name);
      }
    }
  } catch {
    return [];
  }
  return out;
}

function stateCompletedPhaseIds(state = {}) {
  return (state?.execution?.phase_details || [])
    .filter((detail) => detail?.id && detail.status === 'completed')
    .map((detail) => detail.id);
}

export function completedPhaseIds(cwd, state = {}) {
  return [...new Set([...diskCompletedPhaseIds(cwd), ...stateCompletedPhaseIds(state)])].sort();
}

export function validateCompletedPhaseImmutability({ oldText, newText, completedIds }) {
  const issues = [];
  const oldBlocks = phaseBlocks(oldText);
  const newBlocks = phaseBlocks(newText);

  for (const phaseId of completedIds || []) {
    const oldBlock = oldBlocks.get(phaseId);
    const newBlock = newBlocks.get(phaseId);
    if (!oldBlock) {
      issues.push(`${phaseId}:old_contract:missing`);
      continue;
    }
    if (!newBlock) {
      issues.push(`${phaseId}:new_contract:missing`);
      continue;
    }
    if (oldBlock !== newBlock) {
      issues.push(`${phaseId}:contract:modified`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
