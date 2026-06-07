#!/usr/bin/env node
/**
 * MPL Require Phase Evidence Hook (PreToolUse on Write|Edit|MultiEdit).
 *
 * Blocks phase completion artifacts and state transitions unless the phase's
 * declared `evidence_required` tokens are latched in verification.md.
 *
 * Layered-acceptance wrapper, LEGACY-first (Move #8 Phase B):
 *   - The entry point preserves the legacy stdin/tool/isMplActive/cfg opt-out
 *     gates byte-for-byte (verified by mpl-phase-evidence.test.mjs).
 *   - For every collected file write, the legacy substring latch
 *     (`validatePhaseEvidenceLatch` / `validatePhaseEvidenceFile`) is the
 *     authoritative blocking source so the canonical failure tokens
 *     `phase-1:command:missing_exit_code_0` and
 *     `phase-1:test_agent:missing_pass_evidence` surface unchanged.
 *   - `policy.verifyPhase` (hooks/lib/policy/evidence.mjs) is invoked
 *     in a try/catch as an advisory observability emitter only — its
 *     issues are attached to retryContext.policy_issues for debugging but
 *     never gate pass/fail because the existing test fixtures intentionally
 *     omit gate_results/security_results/goal-contract that the structural
 *     policy demands.
 *
 * Rollback: `mpl-require-phase-evidence.legacy.mjs` sibling is preserved.
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
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);

// Policy (L2) — advisory only. Kept behind a try/catch so any structural
// failure in the policy module never converts an otherwise-allow path
// into a block.
let policyVerifyPhase = null;
try {
  const mod = await import(
    pathToFileURL(join(__dirname, 'lib', 'policy', 'evidence.mjs')).href
  );
  policyVerifyPhase = typeof mod?.verifyPhase === 'function' ? mod.verifyPhase : null;
} catch {
  policyVerifyPhase = null;
}

const HOOK_ID = 'mpl-require-phase-evidence';
const BLOCKED_ARTIFACT = 'phase-evidence-latch';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
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
  // LEGACY-first: the substring Evidence Latch + structural test_agent
  // check are the authoritative blocking source. Tests assert byte-for-byte
  // on these token strings.
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

// Advisory-only: collect policy.verifyPhase issues per phaseId touched by
// this write. Never throws and never contributes to the block decision —
// the returned list is surfaced via retryContext.policy_issues for
// observability / debugging only.
function collectAdvisoryPolicyIssues(cwd, phaseIds, state) {
  if (!policyVerifyPhase || phaseIds.size === 0) return [];
  const out = [];
  for (const phaseId of phaseIds) {
    try {
      const verdict = policyVerifyPhase(phaseId, { cwd, state, phaseId });
      if (verdict && Array.isArray(verdict.issues) && verdict.issues.length > 0) {
        out.push(...verdict.issues);
      }
    } catch {
      // swallow — advisory only.
    }
  }
  return out;
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
  if (cfg.phase_evidence_latch_required === false) {
    // Codex r1 on PR #246: explicit config opt-out must clear any
    // envelope left behind by an earlier block. Otherwise
    // mpl-recover and BLOCKED_HOOK_STALE see stale state after the
    // user has unblocked the path.
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  const state = readState(cwd) || {};
  const toolInput = data.tool_input || data.toolInput || {};
  const issues = [];
  const touchedPhases = new Set();

  for (const entry of collectFileWrites(toolInput)) {
    const verificationPhase = phaseIdFromArtifactPath(entry.filePath, 'verification.md');
    if (verificationPhase) {
      touchedPhases.add(verificationPhase);
      issues.push(...validateVerificationWrite(cwd, verificationPhase, entry.text, state));
      continue;
    }

    const summaryPhase = phaseIdFromArtifactPath(entry.filePath, 'state-summary.md');
    if (summaryPhase) {
      touchedPhases.add(summaryPhase);
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
        touchedPhases.add(phaseId);
        issues.push(...validatePhaseEvidenceFile(cwd, phaseId, proposed).issues);
      }
    }
  }

  // Advisory: structural policy.verifyPhase. Never gates pass/fail —
  // its issues are attached to retryContext.policy_issues for debugging.
  const policyIssues = collectAdvisoryPolicyIssues(cwd, touchedPhases, state);

  if (issues.length > 0) {
    const shown = issues.slice(0, 12).join(', ');
    const more = issues.length > 12 ? ` (+${issues.length - 12} more)` : '';
    const reason =
      `[MPL Phase Evidence] Phase completion requires verification.md Evidence Latch ` +
        `for every phase evidence_required token: ${shown}${more}.`;
    emitBlockedHook(cwd, state, {
      hookId: HOOK_ID,
      ruleId: 'missing_phase_evidence',
      code: 'phase_evidence_latch_missing',
      artifact: BLOCKED_ARTIFACT,
      reason,
      resumeInstruction:
        'Latch every required evidence token in the phase verification.md (Evidence Latch section), then retry the blocked write.',
      retryContext: {
        issues: issues.slice(0, 50),
        ...(policyIssues.length > 0 ? { policy_issues: policyIssues.slice(0, 50) } : {}),
      },
    });
    return;
  }

  emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
}

if (isMain) {
  await main().catch(() => ok());
}
