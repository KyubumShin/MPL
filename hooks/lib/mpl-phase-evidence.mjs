/**
 * Phase evidence latch validation.
 *
 * The decomposer declares `evidence_required` per phase. A phase may only be
 * counted complete after `.mpl/mpl/phases/{phase}/verification.md` records an
 * Evidence Latch satisfying each declared evidence token.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function parseInlineList(value) {
  const v = String(value || '').trim();
  if (!v.startsWith('[') || !v.endsWith(']')) return null;
  return v
    .slice(1, -1)
    .split(',')
    .map((x) => normalizeToken(x))
    .filter(Boolean);
}

function phaseBlocks(text) {
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (cur) blocks.push(cur);
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

function extractListField(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = block.match(new RegExp(`^[ \\t]+${escaped}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, 'm'));
  if (inline) {
    const parsed = parseInlineList(inline[1]);
    if (parsed) return parsed;
    const scalar = normalizeToken(inline[1]);
    return scalar ? [scalar] : [];
  }

  const nested = block.match(new RegExp(`^([ \\t]+)${escaped}[ \\t]*:[ \\t]*\\n((?:\\1[ \\t]+.+\\n?)*)`, 'm'));
  if (!nested) return [];
  return nested[2]
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*-\s+(.+?)\s*$/);
      return m ? normalizeToken(m[1]) : null;
    })
    .filter(Boolean);
}

function hasGoalTrace(block) {
  return /^\s+goal_trace\s*:/m.test(block) &&
    /\b(?:AC|AX)-[\w-]+\b/i.test(block);
}

export function parsePhaseEvidenceText(text) {
  const phases = phaseBlocks(text).map((block) => ({
    id: block.id,
    evidence_required: extractListField(block.text, 'evidence_required'),
    has_goal_trace: hasGoalTrace(block.text),
  }));
  return { phases };
}

export function readPhaseEvidence(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(path)) return null;
  return parsePhaseEvidenceText(readFileSync(path, 'utf-8'));
}

export function phaseIdFromArtifactPath(filePath, artifactName) {
  if (!filePath || typeof filePath !== 'string') return null;
  const escaped = artifactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = filePath.match(new RegExp(`(^|/)\\.mpl/mpl/phases/(phase-[\\w.-]+)/${escaped}$`));
  return m ? m[2] : null;
}

function hasEvidenceLatch(text) {
  return /^#{2,}\s*Evidence[\s_-]+Latch\b/im.test(String(text || '')) ||
    /^\s*evidence_latch\s*:/im.test(String(text || ''));
}

function lineForToken(text, token) {
  const normalized = normalizeToken(token);
  const matches = String(text || '')
    .split('\n')
    .filter((line) => normalizeToken(line).includes(normalized));
  return matches.find((line) => lineHasPass(line)) || matches[0];
}

function lineHasPass(line) {
  return /\bpass(?:ed)?\b/i.test(line || '') ||
    /\bexit[_\s-]?code\s*[:=]\s*0\b/i.test(line || '') ||
    /\bresult\s*[:=]\s*(?:ok|pass|passed)\b/i.test(line || '');
}

function commandEvidenceOk(text) {
  return /\bcommand\b/i.test(text || '') &&
    /\bexit[_\s-]?code\s*[:=]\s*0\b/i.test(text || '');
}

function goalTraceEvidenceOk(text, phase) {
  if (!phase?.has_goal_trace) return false;
  const line = lineForToken(text, 'goal_trace');
  return Boolean(line && (lineHasPass(line) || /\b(?:AC|AX)-[\w-]+\b/i.test(line)));
}

export function validatePhaseEvidenceLatch({ phase, phaseId, verificationText, state = {} }) {
  const issues = [];
  const required = phase?.evidence_required || [];
  if (!phase) {
    issues.push(`${phaseId}:phase:missing`);
    return { valid: false, issues };
  }
  if (required.length === 0) {
    issues.push(`${phaseId}:evidence_required:missing`);
    return { valid: false, issues };
  }
  if (!hasEvidenceLatch(verificationText)) {
    issues.push(`${phaseId}:evidence_latch:missing`);
  }

  for (const token of required) {
    if (token === 'command') {
      if (!commandEvidenceOk(verificationText)) issues.push(`${phaseId}:command:missing_exit_code_0`);
      continue;
    }
    if (token === 'test_agent') {
      if (!state?.test_agent_dispatched?.[phaseId]) issues.push(`${phaseId}:test_agent:missing_dispatch`);
      continue;
    }
    if (token === 'goal_trace') {
      if (!goalTraceEvidenceOk(verificationText, phase)) issues.push(`${phaseId}:goal_trace:missing_latch`);
      continue;
    }

    const line = lineForToken(verificationText, token);
    if (!line || !lineHasPass(line)) issues.push(`${phaseId}:${token}:missing_pass_latch`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function validatePhaseEvidenceFile(cwd, phaseId, state = {}) {
  const parsed = readPhaseEvidence(cwd);
  const phase = parsed?.phases?.find((p) => p.id === phaseId);
  const path = join(cwd, '.mpl', 'mpl', 'phases', phaseId, 'verification.md');
  if (!existsSync(path)) {
    return { valid: false, issues: [`${phaseId}:verification:missing`] };
  }
  return validatePhaseEvidenceLatch({
    phase,
    phaseId,
    verificationText: readFileSync(path, 'utf-8'),
    state,
  });
}

export function newlyCompletedPhaseIds(previousState = {}, proposedState = {}) {
  const previous = new Map(
    (previousState?.execution?.phase_details || []).map((p) => [p.id, p.status])
  );
  const out = [];
  for (const detail of proposedState?.execution?.phase_details || []) {
    if (!detail?.id) continue;
    if (detail.status === 'completed' && previous.get(detail.id) !== 'completed') {
      out.push(detail.id);
    }
  }
  return out;
}
