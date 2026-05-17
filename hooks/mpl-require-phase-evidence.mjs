#!/usr/bin/env node
/**
 * MPL Require Phase Evidence Hook (PreToolUse on Write|Edit|MultiEdit).
 *
 * Blocks phase completion artifacts and state transitions unless the phase's
 * declared `evidence_required` tokens are latched in verification.md.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
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
  newlyCompletedPhaseIds,
  phaseIdFromArtifactPath,
  readPhaseEvidence,
  validatePhaseEvidenceFile,
  validatePhaseEvidenceLatch,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-phase-evidence.mjs')).href
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

function isStatePath(filePath, cwd) {
  if (!filePath || typeof filePath !== 'string') return false;
  const abs = resolve(cwd, filePath);
  return abs.endsWith(`.mpl${sep}state.json`) || abs.endsWith('.mpl/state.json');
}

function simulateWrittenState(toolName, toolInput, cwd) {
  const t = String(toolName || '').toLowerCase();
  const fp = toolInput?.file_path || toolInput?.filePath;
  const abs = fp ? resolve(cwd, fp) : null;

  if (t === 'write') {
    if (typeof toolInput.content !== 'string') return null;
    try { return JSON.parse(toolInput.content); } catch { return null; }
  }

  if (t === 'edit' || t === 'multiedit') {
    if (!abs || !existsSync(abs)) return null;
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { return null; }

    const apply = (oldStr, newStr, replaceAll) => {
      if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
      if (replaceAll === true) return content.split(oldStr).join(newStr);
      const idx = content.indexOf(oldStr);
      if (idx === -1) return null;
      return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    };

    if (t === 'edit') {
      const next = apply(toolInput.old_string, toolInput.new_string, toolInput.replace_all);
      if (next === null) return null;
      content = next;
    } else {
      if (!Array.isArray(toolInput.edits)) return null;
      for (const edit of toolInput.edits) {
        const next = apply(edit?.old_string, edit?.new_string, edit?.replace_all);
        if (next === null) return null;
        content = next;
      }
    }
    try { return JSON.parse(content); } catch { return null; }
  }

  return null;
}

function validateVerificationWrite(cwd, phaseId, text, state) {
  const parsed = readPhaseEvidence(cwd);
  const phase = parsed?.phases?.find((p) => p.id === phaseId);
  return validatePhaseEvidenceLatch({
    phase,
    phaseId,
    verificationText: text,
    state,
  }).issues;
}

function validateStateSummaryWrite(cwd, phaseId, state) {
  return validatePhaseEvidenceFile(cwd, phaseId, state).issues;
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
  if (cfg.phase_evidence_latch_required === false) return ok();

  const state = readState(cwd) || {};
  const toolInput = data.tool_input || data.toolInput || {};
  const issues = [];

  for (const entry of collectFileWrites(toolInput)) {
    const verificationPhase = phaseIdFromArtifactPath(entry.filePath, 'verification.md');
    if (verificationPhase) {
      issues.push(...validateVerificationWrite(cwd, verificationPhase, entry.text, state));
      continue;
    }

    const summaryPhase = phaseIdFromArtifactPath(entry.filePath, 'state-summary.md');
    if (summaryPhase) {
      issues.push(...validateStateSummaryWrite(cwd, summaryPhase, state));
      continue;
    }

    if (isStatePath(entry.filePath, cwd)) {
      const proposed = simulateWrittenState(toolName, toolInput, cwd);
      if (!proposed || typeof proposed !== 'object') continue;
      const completed = newlyCompletedPhaseIds(state, proposed);
      const priorCount = state?.execution?.phases?.completed ?? 0;
      const nextCount = proposed?.execution?.phases?.completed ?? priorCount;
      if (nextCount > priorCount && completed.length === 0) {
        issues.push(`state:phase_completion:missing_phase_detail`);
      }
      for (const phaseId of completed) {
        issues.push(...validatePhaseEvidenceFile(cwd, phaseId, proposed).issues);
      }
    }
  }

  if (issues.length > 0) {
    const shown = issues.slice(0, 12).join(', ');
    const more = issues.length > 12 ? ` (+${issues.length - 12} more)` : '';
    block(
      `[MPL Phase Evidence] Phase completion requires verification.md Evidence Latch ` +
        `for every phase evidence_required token: ${shown}${more}.`
    );
    return;
  }

  ok();
}

if (isMain) {
  await main().catch(() => ok());
}
