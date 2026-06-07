/**
 * MPL Contracts Policy (L2 module — Move #8, Phase A)
 *
 * SSOT for declarative phase / goal / chain / decomposition contract
 * decisions. Composes (does NOT re-implement) existing L1 helpers and
 * returns a uniform decision envelope so the 13 require-* hooks can
 * become thin wrappers in Phase B.
 *
 * Public API:
 *   handle(event, ctx) -> decision
 *   handleChainAssignment, handleCovers, handleDecompositionDelta,
 *   handleGoalTrace, handlePhaseContractGraph, handleReviewer,
 *   handleTestAgentBrief, handleTestAgentPostRun, handleE2eGate,
 *   handleE2eAuthenticity, handleFinalizeArtifacts,
 *   handleWholeGoalClosure
 *
 * Decision envelope shape:
 *   { action: 'allow' | 'block',
 *     code, reason, ruleId,
 *     artifact, resumeInstruction, retryContext }
 *
 * Dependency boundary (per hooks/lib/policy/README.md):
 *   - Imports L1 helpers and `policy/evidence.mjs` ONLY.
 *   - NEVER imports another non-evidence policy module.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { isPassingTestAgentEvidence } from '../mpl-test-agent-evidence.mjs';
import { parsePhaseContractGraphText, validatePhaseContractGraph } from '../mpl-phase-contract-graph.mjs';
import {
  findMatchingDecompositionDelta,
  parseDecompositionDeltaText,
  parseRecomposeCount,
  targetCountFromDeltaPath,
  validateDecompositionDelta,
} from '../mpl-decomposition-delta.mjs';
import {
  parseDecompositionGoalTraceText,
  validateGoalTraceCoverage,
  validateMvpGoalTraceCoverage,
} from '../mpl-goal-trace.mjs';
import {
  readGoalContract,
  readBaselineGoalContractHash,
  defaultRequiredArtifacts,
} from '../mpl-goal-contract.mjs';
import { validateBrief } from '../mpl-test-agent-brief.mjs';
import { validateWholeGoalClosure } from '../mpl-whole-goal-closure.mjs';
import { verifyPhase } from './evidence.mjs';

// ============================================================================
// Decision envelope builders
// ============================================================================

const HOOK_IDS = Object.freeze({
  chain_assignment: 'mpl-require-chain-assignment',
  covers: 'mpl-require-covers',
  decomposition_delta: 'mpl-require-decomposition-delta',
  goal_trace: 'mpl-require-goal-trace',
  phase_contract_graph: 'mpl-require-phase-contract-graph',
  reviewer: 'mpl-require-reviewer',
  test_agent_brief: 'mpl-require-test-agent-brief',
  test_agent_postrun: 'mpl-require-test-agent',
  e2e: 'mpl-require-e2e',
  e2e_authenticity: 'mpl-require-e2e-authenticity',
  finalize_artifacts: 'mpl-require-finalize-artifacts',
  whole_goal_closure: 'mpl-require-whole-goal-closure',
  phase_evidence: 'mpl-require-phase-evidence',
});

function allow({ ruleId, artifact } = {}) {
  return {
    action: 'allow',
    code: null,
    reason: null,
    ruleId: ruleId || null,
    artifact: artifact || null,
    resumeInstruction: null,
    retryContext: null,
  };
}

function block({ ruleId, code, reason, artifact, resumeInstruction, retryContext } = {}) {
  return {
    action: 'block',
    code: code || 'blocked',
    reason: reason || 'Contract violation.',
    ruleId: ruleId || null,
    artifact: artifact || null,
    resumeInstruction: resumeInstruction || 'Resolve the recorded contract violation, then retry.',
    retryContext: retryContext || {},
  };
}

// ============================================================================
// Helpers
// ============================================================================

function isConfigRequired(config, path, defaultRequired = true) {
  // path is like 'contracts.chain_assignment.required'
  const parts = path.split('.');
  let cur = config;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return defaultRequired;
    cur = cur[p];
  }
  if (cur === undefined) return defaultRequired;
  return cur === true;
}

function legacyRequiredFlag(config, key, defaultRequired = true) {
  // Workspace legacy flag wins when explicitly false (per the staging plan).
  if (config && config[key] === false) return false;
  return defaultRequired;
}

function readTextIfExists(cwd, rel) {
  const abs = join(cwd, rel);
  if (!existsSync(abs)) return null;
  try { return readFileSync(abs, 'utf-8'); }
  catch { return null; }
}

function readJsonIfExists(cwd, rel) {
  const text = readTextIfExists(cwd, rel);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

function collectDecompositionTexts(toolInput) {
  if (!toolInput) return [];
  const out = [];
  const push = (fp, text) => {
    if (typeof fp === 'string' && /\.mpl\/mpl\/decomposition\.ya?ml$/.test(fp) && typeof text === 'string') {
      out.push(text);
    }
  };
  push(toolInput.file_path || toolInput.filePath, toolInput.content || toolInput.new_string || toolInput.newString);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      push(e?.file_path || e?.filePath, e?.content || e?.new_string || e?.newString);
    }
  }
  return out;
}

function isFinalizeDoneWrite(toolInput) {
  if (!toolInput) return false;
  const paths = [];
  const texts = [];
  const collect = (obj) => {
    if (!obj) return;
    if (obj.file_path) paths.push(obj.file_path);
    if (obj.filePath) paths.push(obj.filePath);
    for (const k of ['new_string', 'newString', 'content']) {
      if (typeof obj[k] === 'string') texts.push(obj[k]);
    }
  };
  collect(toolInput);
  if (Array.isArray(toolInput.edits)) for (const e of toolInput.edits) collect(e);
  if (!paths.some((p) => /\.mpl\/state\.json$/.test(p))) return false;
  return texts.some((t) => /"finalize_done"\s*:\s*true/.test(t));
}

function extractPhaseIdFromText(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bphase-(\d+)\b/);
  return m ? `phase-${m[1]}` : null;
}

function readTestAgentRequiredField(cwd, phaseId) {
  const text = readTextIfExists(cwd, '.mpl/mpl/decomposition.yaml');
  if (!text) return null;
  const idMatch = new RegExp(`(^|\\n)\\s*-\\s*id\\s*:\\s*${phaseId}\\b`).exec(text);
  if (!idMatch) return null;
  const tail = text.slice(idMatch.index);
  const nextSibling = tail.slice(1).search(/\n\s*-\s*id\s*:/);
  const phaseBlock = nextSibling === -1 ? tail : tail.slice(0, nextSibling + 1);
  const flag = phaseBlock.match(/^\s*test_agent_required\s*:\s*(true|false)/im);
  if (!flag) return null;
  return flag[1].toLowerCase() === 'true';
}

// ============================================================================
// Per-rule handlers
// ============================================================================

/**
 * AP-CHAIN-01 — chain_seed.enabled=true requires .mpl/mpl/chain-assignment.yaml.
 */
export function handleChainAssignment(ctx) {
  const { cwd, toolInput, toolName } = ctx;
  if (!['Task', 'Agent', 'task', 'agent'].includes(String(toolName || ''))) return allow();
  const sub = String(toolInput?.subagent_type || toolInput?.subagentType || '');
  if (!['mpl-seed-generator', 'mpl:mpl-seed-generator'].includes(sub)) return allow();

  // chain_seed.enabled lives in .mpl/config.json per the original hook.
  let enabled = false;
  try {
    const raw = readTextIfExists(cwd, '.mpl/config.json');
    if (raw) enabled = JSON.parse(raw)?.chain_seed?.enabled === true;
  } catch { /* fall through → enabled=false */ }
  if (!enabled) return allow({ ruleId: 'missing_chain_assignment', artifact: '.mpl/mpl/chain-assignment.yaml' });

  if (existsSync(join(cwd, '.mpl', 'mpl', 'chain-assignment.yaml'))) {
    return allow({ ruleId: 'missing_chain_assignment', artifact: '.mpl/mpl/chain-assignment.yaml' });
  }
  return block({
    ruleId: 'missing_chain_assignment',
    code: 'chain_assignment_missing',
    artifact: '.mpl/mpl/chain-assignment.yaml',
    reason:
      '[MPL AP-CHAIN-01] Seed Generator BLOCKED: chain_seed.enabled=true but ' +
      '.mpl/mpl/chain-assignment.yaml is missing.',
    resumeInstruction:
      'Run Step 3-G (Chain Derivation) and write .mpl/mpl/chain-assignment.yaml, then retry mpl-seed-generator.',
    retryContext: { schema_reference: 'docs/schemas/chain-assignment.md' },
  });
}

/**
 * Tier B covers schema check for decomposition.yaml writes.
 */
export function handleCovers(ctx) {
  const { cwd, toolInput } = ctx;
  const texts = collectDecompositionTexts(toolInput);
  if (texts.length === 0) return allow();

  const ucRe = /^UC-\d{2,}$/;
  const legacy = !existsSync(join(cwd, '.mpl', 'requirements', 'user-contract.md'));
  const issues = [];

  for (const text of texts) {
    // Lightweight inline parse — re-use the original hook's regex.
    const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
    let cur = null;
    let inCovers = false;
    let coversIndent = -1;
    const phases = [];
    for (const line of lines) {
      const phaseMatch = line.match(/^\s*-\s+id:\s*["']?(phase-[\w-]+)["']?/);
      if (phaseMatch) {
        if (cur) phases.push(cur);
        cur = { id: phaseMatch[1], covers: null };
        inCovers = false;
        continue;
      }
      if (!cur) continue;
      const inline = line.match(/^(\s*)covers\s*:\s*\[(.*)\]\s*$/);
      if (inline) {
        cur.covers = inline[2].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        inCovers = false;
        continue;
      }
      const block_ = line.match(/^(\s*)covers\s*:\s*$/);
      if (block_) {
        coversIndent = block_[1].length;
        cur.covers = [];
        inCovers = true;
        continue;
      }
      if (inCovers) {
        const im = line.match(/^(\s*)-\s+["']?([^"'\s#]+)["']?/);
        if (im && im[1].length > coversIndent) {
          cur.covers.push(im[2]);
          continue;
        }
        if (line.trim() !== '' && !line.startsWith(' '.repeat(coversIndent + 1))) inCovers = false;
      }
    }
    if (cur) phases.push(cur);

    for (const phase of phases) {
      if (phase.covers === null) { issues.push({ kind: 'missing', phase: phase.id }); continue; }
      if (!Array.isArray(phase.covers) || phase.covers.length === 0) { issues.push({ kind: 'empty', phase: phase.id }); continue; }
      for (const entry of phase.covers) {
        if (entry === 'internal') continue;
        if (ucRe.test(entry)) continue;
        if (legacy) continue;
        issues.push({ kind: 'invalid_entry', phase: phase.id, entry });
      }
    }
  }

  if (issues.length === 0) return allow({ ruleId: 'covers_schema_violation', artifact: '.mpl/mpl/decomposition.yaml' });

  const summary = issues.slice(0, 10).map((i) =>
    i.kind === 'missing' ? `${i.phase}: covers field missing` :
    i.kind === 'empty' ? `${i.phase}: covers is empty` :
    `${i.phase}: invalid covers entry "${i.entry}"`
  ).join('; ');
  const more = issues.length > 10 ? ` (+${issues.length - 10} more)` : '';
  return block({
    ruleId: 'covers_schema_violation',
    code: 'covers_schema_violation',
    artifact: '.mpl/mpl/decomposition.yaml',
    reason: `Tier B schema violation in decomposition.yaml: ${summary}${more}.`,
    resumeInstruction: 'Add a non-empty covers list (UC-NN or "internal") to every phase, then retry.',
    retryContext: { issue_count: issues.length, issues: issues.slice(0, 20), legacy_mode: legacy },
  });
}

/**
 * Decomposition delta gate — full-rewrites require a matching delta file.
 */
export function handleDecompositionDelta(ctx) {
  const { cwd, toolInput, toolName, config } = ctx;
  if (legacyRequiredFlag(config, 'decomposition_delta_required', isConfigRequired(config, 'contracts.decomposition.require_delta')) === false) {
    return allow({ ruleId: 'missing_decomposition_delta', artifact: '.mpl/mpl/decomposition-deltas/' });
  }

  if (!toolInput) return allow();
  const isFullWrite = ['Write', 'write'].includes(String(toolName || ''));
  const entries = [];
  const collect = (fp, txt) => {
    if (typeof fp !== 'string') return;
    entries.push({ filePath: fp, text: typeof txt === 'string' ? txt : '' });
  };
  collect(toolInput.file_path || toolInput.filePath, toolInput.content || toolInput.new_string || toolInput.newString);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) collect(e?.file_path || e?.filePath, e?.content || e?.new_string || e?.newString);
  }

  const issues = [];
  for (const entry of entries) {
    const isDelta = /(^|\/)\.mpl\/mpl\/decomposition-delta\.ya?ml$/.test(entry.filePath) ||
                    /(^|\/)\.mpl\/mpl\/decomposition-deltas\/[^/]+\.ya?ml$/.test(entry.filePath);
    const isDecomp = /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(entry.filePath);
    if (!isDelta && !isDecomp) continue;

    if (isDelta) {
      if (!isFullWrite) { issues.push('delta_write:partial_edit_not_allowed'); continue; }
      if (!entry.text.trim()) { issues.push('delta_write:empty'); continue; }
      const existingPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
      if (!existsSync(existingPath)) { issues.push('decomposition:missing_for_delta'); continue; }
      const baseCount = parseRecomposeCount(parsePhaseContractGraphText(readFileSync(existingPath, 'utf-8')).recompose_count);
      if (!Number.isInteger(baseCount)) { issues.push('decomposition:recompose_count:missing'); continue; }
      const pathTarget = targetCountFromDeltaPath(entry.filePath);
      const delta = parseDecompositionDeltaText(entry.text);
      const verdict = validateDecompositionDelta(delta, {
        expectedBase: baseCount,
        expectedTarget: baseCount + 1,
        ...(pathTarget === null ? {} : { expectedPathTarget: pathTarget }),
      });
      issues.push(...verdict.issues);
      continue;
    }

    if (isDecomp) {
      const existingPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
      if (!existsSync(existingPath)) continue;
      const oldText = readFileSync(existingPath, 'utf-8');
      if (entry.text.trim() === oldText.trim()) continue;
      if (!isFullWrite) { issues.push('decomposition:partial_edit_not_allowed'); continue; }
      if (!entry.text.trim()) { issues.push('decomposition:empty_write'); continue; }
      const oldCount = parseRecomposeCount(parsePhaseContractGraphText(oldText).recompose_count);
      const newCount = parseRecomposeCount(parsePhaseContractGraphText(entry.text).recompose_count);
      if (!Number.isInteger(oldCount)) { issues.push('decomposition:old_recompose_count:missing'); continue; }
      if (!Number.isInteger(newCount)) { issues.push('decomposition:new_recompose_count:missing'); continue; }
      if (newCount !== oldCount + 1) {
        issues.push(`recompose_count:expected:${oldCount + 1}:actual:${newCount}`);
        continue;
      }
      const delta = findMatchingDecompositionDelta(cwd, oldCount, newCount);
      if (!delta) { issues.push(`decomposition_delta:missing:recompose-${newCount}.yaml`); continue; }
      if (!delta.verdict.valid) {
        issues.push(...delta.verdict.issues.map((iss) => `decomposition_delta:${iss}`));
      }
    }
  }

  if (issues.length === 0) return allow({ ruleId: 'missing_decomposition_delta', artifact: '.mpl/mpl/decomposition-deltas/' });
  return block({
    ruleId: 'missing_decomposition_delta',
    code: 'decomposition_delta_missing',
    artifact: '.mpl/mpl/decomposition-deltas/',
    reason: `[MPL Decomposition Delta] ${issues.slice(0, 12).join(', ')}${issues.length > 12 ? ` (+${issues.length - 12} more)` : ''}.`,
    resumeInstruction: 'Write .mpl/mpl/decomposition-deltas/recompose-N.yaml first, then retry the rewrite.',
    retryContext: { issues: issues.slice(0, 50) },
  });
}

/**
 * goal_trace coverage check vs the frozen goal contract.
 */
export function handleGoalTrace(ctx) {
  const { cwd, toolInput, config } = ctx;
  if (legacyRequiredFlag(config, 'goal_trace_required', isConfigRequired(config, 'contracts.goal_trace.required')) === false ||
      legacyRequiredFlag(config, 'goal_contract_required', true) === false) {
    return allow({ ruleId: 'missing_goal_trace', artifact: '.mpl/mpl/decomposition.yaml' });
  }
  const texts = collectDecompositionTexts(toolInput);
  if (texts.length === 0) return allow();

  const goal = readGoalContract(cwd);
  if (!goal.exists || !goal.valid) {
    return block({
      ruleId: 'missing_goal_trace',
      code: 'goal_contract_invalid',
      artifact: '.mpl/mpl/decomposition.yaml',
      reason: `[MPL Goal Trace] goal contract missing or invalid: ${goal.missing.join(', ')}.`,
      resumeInstruction: 'Restore a valid .mpl/goal-contract.yaml, then retry the decomposition write.',
      retryContext: { missing: goal.missing },
    });
  }
  const baseline = readBaselineGoalContractHash(cwd);
  if (baseline.error) {
    return block({
      ruleId: 'missing_goal_trace',
      code: 'goal_contract_baseline_corrupt',
      artifact: '.mpl/mpl/decomposition.yaml',
      reason: `[MPL Goal Trace] corrupt baseline.yaml goal_contract sha256 (${baseline.error}).`,
      resumeInstruction: 'Re-run Phase 0 renewal so baseline.yaml records a valid goal_contract sha256.',
      retryContext: { baseline_error: baseline.error },
    });
  }
  if (baseline.hash && baseline.hash !== goal.contract.content_sha256) {
    return block({
      ruleId: 'missing_goal_trace',
      code: 'goal_contract_drift',
      artifact: '.mpl/mpl/decomposition.yaml',
      reason: `[MPL Goal Trace] goal contract drifted from baseline.yaml (baseline=${baseline.hash}, current=${goal.contract.content_sha256}).`,
      resumeInstruction: 'Resolve the Goal Contract drift via Phase 0 renewal.',
      retryContext: { baseline_hash: baseline.hash, current_hash: goal.contract.content_sha256 },
    });
  }

  const issues = [];
  for (const text of texts) {
    const decomposition = parseDecompositionGoalTraceText(text);
    const v = validateGoalTraceCoverage(decomposition, goal.contract);
    issues.push(...v.issues);
    if (goal.contract?.mvp_scope) {
      const graph = parsePhaseContractGraphText(text);
      const mv = validateMvpGoalTraceCoverage(decomposition, goal.contract, graph);
      issues.push(...mv.issues);
    }
  }
  if (issues.length === 0) return allow({ ruleId: 'missing_goal_trace', artifact: '.mpl/mpl/decomposition.yaml' });
  return block({
    ruleId: 'missing_goal_trace',
    code: 'goal_trace_incomplete',
    artifact: '.mpl/mpl/decomposition.yaml',
    reason: `[MPL Goal Trace] decomposition.yaml does not cover the frozen Goal Contract: ${issues.slice(0, 12).join(', ')}${issues.length > 12 ? ` (+${issues.length - 12} more)` : ''}.`,
    resumeInstruction: 'Add or fix per-phase goal_trace coverage for every required AC/AX, then retry.',
    retryContext: { issue_count: issues.length, issues: issues.slice(0, 20) },
  });
}

/**
 * Phase contract graph well-formedness.
 */
export function handlePhaseContractGraph(ctx) {
  const { cwd, toolInput, config } = ctx;
  if (legacyRequiredFlag(config, 'phase_contract_graph_required', isConfigRequired(config, 'contracts.phase_contract_graph.required')) === false) {
    return allow({ ruleId: 'phase_contract_graph_invalid', artifact: '.mpl/mpl/decomposition.yaml' });
  }
  const texts = collectDecompositionTexts(toolInput);
  if (texts.length === 0) return allow();

  const issues = [];
  for (const text of texts) {
    const graph = parsePhaseContractGraphText(text);
    const v = validatePhaseContractGraph(graph);
    issues.push(...v.issues);
  }

  // Released-cut immutability (Phase 1.6+ once state.release exists).
  const stateReleaseCompleted = ctx.state?.release?.completed_cut_ids;
  if (Array.isArray(stateReleaseCompleted) && stateReleaseCompleted.length > 0) {
    const existingPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
    if (existsSync(existingPath)) {
      const oldGraph = parsePhaseContractGraphText(readFileSync(existingPath, 'utf-8'));
      for (const text of texts) {
        const newGraph = parsePhaseContractGraphText(text);
        const oldCuts = new Map();
        const newCuts = new Map();
        if (oldGraph?.mvp?.phases) oldCuts.set('mvp', [...oldGraph.mvp.phases]);
        if (newGraph?.mvp?.phases) newCuts.set('mvp', [...newGraph.mvp.phases]);
        for (const c of (oldGraph?.release_cuts || [])) if (c?.id) oldCuts.set(c.id, [...(c.phases || [])]);
        for (const c of (newGraph?.release_cuts || [])) if (c?.id) newCuts.set(c.id, [...(c.phases || [])]);
        for (const cutId of stateReleaseCompleted) {
          const oldP = oldCuts.get(cutId);
          const newP = newCuts.get(cutId);
          if (oldP === undefined) continue;
          if (newP === undefined) { issues.push(`released_cut:${cutId}:removed_from_graph`); continue; }
          if (oldP.length !== newP.length || oldP.some((v, i) => v !== newP[i])) {
            issues.push(`released_cut:${cutId}:phases:mutated`);
          }
        }
      }
    }
  }

  if (issues.length === 0) return allow({ ruleId: 'phase_contract_graph_invalid', artifact: '.mpl/mpl/decomposition.yaml' });
  return block({
    ruleId: 'phase_contract_graph_invalid',
    code: 'phase_contract_graph_invalid',
    artifact: '.mpl/mpl/decomposition.yaml',
    reason: `[MPL Phase Contract Graph] decomposition.yaml is not a valid phase contract graph: ${issues.slice(0, 12).join(', ')}${issues.length > 12 ? ` (+${issues.length - 12} more)` : ''}.`,
    resumeInstruction: 'Re-emit decomposition.yaml as a valid phase contract graph with metadata, execution tiers, per-phase policies.',
    retryContext: { issue_count: issues.length, issues: issues.slice(0, 20) },
  });
}

/**
 * #239 C2 / #251 — reviewer_required: false requires a reviewer_rationale.
 * Reads the file from disk (PostToolUse semantics).
 */
export function handleReviewer(ctx) {
  const { cwd, toolInput, config } = ctx;
  if (legacyRequiredFlag(config, 'reviewer_required_check', isConfigRequired(config, 'contracts.reviewer.required')) === false) {
    return allow({ ruleId: 'reviewer_rationale_missing', artifact: '.mpl/mpl/decomposition.yaml' });
  }
  // Hit decomposition.yaml?
  const writes = [];
  const collect = (fp) => { if (typeof fp === 'string' && fp.endsWith('.mpl/mpl/decomposition.yaml')) writes.push(fp); };
  if (toolInput) {
    collect(toolInput.file_path || toolInput.filePath);
    if (Array.isArray(toolInput.edits)) for (const e of toolInput.edits) collect(e?.file_path || e?.filePath);
  }
  if (writes.length === 0) return allow();

  const onDisk = readTextIfExists(cwd, '.mpl/mpl/decomposition.yaml');
  if (!onDisk) return allow();

  // Reuse the original hook's lightweight parser.
  const lines = onDisk.split('\n').map((l) => l.replace(/\r$/, ''));
  const offenders = [];
  let cur = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idMatch = line.match(/^\s*-\s+id\s*:\s*["']?(phase-[\w.-]+)["']?/);
    if (idMatch) {
      if (cur && cur.reviewer_required === false) {
        const trimmed = cur.reviewer_rationale == null ? '' : String(cur.reviewer_rationale).trim();
        if (trimmed.length === 0) offenders.push(cur.id);
      }
      cur = { id: idMatch[1], reviewer_required: null, reviewer_rationale: null };
      i++; continue;
    }
    if (!cur) { i++; continue; }
    const reqMatch = line.match(/^\s+reviewer_required\s*:\s*(.+)$/);
    if (reqMatch) {
      const v = reqMatch[1].trim().toLowerCase().replace(/[#].*$/, '').trim();
      cur.reviewer_required = (v === 'true') ? true : (v === 'false' ? false : null);
      i++; continue;
    }
    const ratMatch = line.match(/^(\s+)reviewer_rationale\s*:\s*(.+)$/);
    if (ratMatch) {
      const rest = ratMatch[2].replace(/\s+#.*$/, '').trim();
      if (/^[|>][+-]?\d?$/.test(rest)) {
        // Block scalar
        const headerIndent = ratMatch[1].length;
        const body = [];
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j];
          if (!next.trim()) { body.push(''); j++; continue; }
          const indent = (next.match(/^(\s*)/) || ['', ''])[1].length;
          if (indent <= headerIndent) break;
          body.push(next.slice(headerIndent + 1));
          j++;
        }
        cur.reviewer_rationale = body.join('\n');
        i = j; continue;
      }
      cur.reviewer_rationale = rest.replace(/^["']|["']$/g, '');
      i++; continue;
    }
    i++;
  }
  if (cur && cur.reviewer_required === false) {
    const trimmed = cur.reviewer_rationale == null ? '' : String(cur.reviewer_rationale).trim();
    if (trimmed.length === 0) offenders.push(cur.id);
  }

  if (offenders.length === 0) return allow({ ruleId: 'reviewer_rationale_missing', artifact: '.mpl/mpl/decomposition.yaml' });
  const list = offenders.map((id) => `  - ${id}`).join('\n');
  return block({
    ruleId: 'reviewer_rationale_missing',
    code: 'reviewer_rationale_missing',
    artifact: '.mpl/mpl/decomposition.yaml',
    reason:
      `[MPL #239 C2 / #251] Phase(s) declared reviewer_required: false ` +
      `without a non-empty reviewer_rationale:\n${list}`,
    resumeInstruction: 'Add a non-empty reviewer_rationale for each offending phase, or set reviewer_required: true.',
    retryContext: { offenders },
  });
}

/**
 * Test-agent brief precondition (#212): PreToolUse on mpl-test-agent dispatch.
 */
export function handleTestAgentBrief(ctx) {
  const { cwd, toolName, toolInput, config } = ctx;
  if (legacyRequiredFlag(config, 'test_agent_brief_required', isConfigRequired(config, 'contracts.test_agent.brief_required')) === false) {
    return allow();
  }
  if (!['Task', 'Agent', 'task', 'agent'].includes(String(toolName || ''))) return allow();
  const sub = String(toolInput?.subagent_type || toolInput?.subagentType || '');
  if (!/mpl-test-agent$/.test(sub)) return allow();

  const phaseId = extractPhaseIdFromText(toolInput?.prompt || toolInput?.description || '');
  if (!phaseId) return allow();

  const explicit = readTestAgentRequiredField(cwd, phaseId);
  // Respect workspace test_agent.default_required when phase omits the field.
  const defaultRequired = config?.test_agent?.default_required !== false;
  const required = (explicit === null) ? defaultRequired : explicit;
  if (!required) return allow({ ruleId: 'test_agent_brief_missing', artifact: `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml` });

  const path = join(cwd, '.mpl', 'mpl', 'phases', phaseId, 'test-agent-brief.yaml');
  const artifact = `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`;
  if (!existsSync(path)) {
    return block({
      ruleId: 'test_agent_brief_missing',
      code: 'test_agent_brief_missing',
      artifact,
      reason: `[MPL #212] mpl-test-agent dispatch for ${phaseId} blocked: brief artifact missing.`,
      resumeInstruction: `Generate a valid ${artifact}, then retry the mpl-test-agent dispatch.`,
      retryContext: { phase_id: phaseId, brief_path: artifact },
    });
  }
  let text;
  try { text = readFileSync(path, 'utf-8'); }
  catch (e) {
    return block({
      ruleId: 'test_agent_brief_missing',
      code: 'test_agent_brief_unreadable',
      artifact,
      reason: `[MPL #212] brief artifact unreadable: ${e?.message || 'unknown'}.`,
      resumeInstruction: `Re-emit ${artifact}, then retry.`,
      retryContext: { phase_id: phaseId, error: e?.message || 'unknown' },
    });
  }
  const { valid, errors } = validateBrief(text, { phaseId });
  if (!valid) {
    return block({
      ruleId: 'test_agent_brief_missing',
      code: 'test_agent_brief_invalid',
      artifact,
      reason: `[MPL #212] brief failed schema validation: ${(errors || []).join('; ')}.`,
      resumeInstruction: `Fix brief schema, then retry the mpl-test-agent dispatch.`,
      retryContext: { phase_id: phaseId, errors: (errors || []).slice(0, 20) },
    });
  }
  return allow({ ruleId: 'test_agent_brief_missing', artifact });
}

/**
 * AD-0007 test-agent PostToolUse evidence gate.
 */
export function handleTestAgentPostRun(ctx) {
  const { cwd, toolName, toolInput, state, config } = ctx;
  if (legacyRequiredFlag(config, 'test_agent_pass_required', isConfigRequired(config, 'contracts.test_agent.pass_required')) === false) {
    return allow();
  }
  if (!['Task', 'Agent', 'task', 'agent'].includes(String(toolName || ''))) return allow();
  const sub = String(toolInput?.subagent_type || toolInput?.subagentType || '');
  if (!/mpl-phase-runner$/.test(sub)) return allow();

  const phaseId = extractPhaseIdFromText(toolInput?.prompt || toolInput?.description || '');
  if (!phaseId) return allow();

  const required = readTestAgentRequiredField(cwd, phaseId);
  const defaultRequired = config?.test_agent?.default_required !== false;
  const effectiveRequired = (required === null) ? defaultRequired : required;
  if (!effectiveRequired) return allow();

  // override file
  let override = {};
  try {
    const raw = readTextIfExists(cwd, '.mpl/config/test-agent-override.json');
    if (raw) override = JSON.parse(raw);
  } catch { /* ignore */ }
  if (override[phaseId] || override['*']) return allow();

  const dispatched = state?.test_agent_dispatched || {};
  if (isPassingTestAgentEvidence(dispatched[phaseId])) {
    return allow({ ruleId: 'missing_or_invalid_test_agent_evidence', artifact: `state.test_agent_dispatched.${phaseId}` });
  }

  return block({
    ruleId: 'missing_or_invalid_test_agent_evidence',
    code: 'missing_or_invalid_test_agent_evidence',
    artifact: `state.test_agent_dispatched.${phaseId}`,
    reason:
      `[MPL AD-0007] Phase ${phaseId} is marked test_agent_required=true but ` +
      `mpl-test-agent has not produced PASS evidence.`,
    resumeInstruction:
      `Dispatch mpl-test-agent for ${phaseId} with valid JSON verdict=PASS, then retry the phase transition.`,
    retryContext: { phase_id: phaseId, override_path: '.mpl/config/test-agent-override.json' },
  });
}

/**
 * AD-0008 E2E gate: finalize_done=true requires required scenarios passing.
 */
export function handleE2eGate(ctx) {
  const { cwd, toolInput, state, config } = ctx;
  if (legacyRequiredFlag(config, 'e2e_required', isConfigRequired(config, 'contracts.e2e.required')) === false) {
    return allow({ ruleId: 'missing_e2e_evidence', artifact: '.mpl/state.json#finalize_done' });
  }
  if (!isFinalizeDoneWrite(toolInput)) return allow();

  const text = readTextIfExists(cwd, '.mpl/mpl/e2e-scenarios.yaml');
  const required = [];
  if (text) {
    let cur = null;
    for (const line of text.split('\n').map((l) => l.replace(/\r$/, ''))) {
      const idMatch = line.match(/^\s*-\s+id:\s*["']?(E2E-[\w-]+)["']?/);
      if (idMatch) {
        if (cur) required.push(cur);
        cur = { id: idMatch[1], test_command: null, required: true };
        continue;
      }
      if (!cur) continue;
      const tcMatch = line.match(/^\s+test_command:\s*["']?(.+?)["']?\s*$/);
      if (tcMatch) cur.test_command = tcMatch[1];
      const reqMatch = line.match(/^\s+required:\s*(true|false)\s*$/i);
      if (reqMatch) cur.required = reqMatch[1].toLowerCase() === 'true';
    }
    if (cur) required.push(cur);
  }
  const declaredRequired = required.filter((s) => s.required !== false);
  const missingCommand = declaredRequired.filter((s) => !s.test_command).map((s) => s.id);
  if (missingCommand.length > 0) {
    return block({
      ruleId: 'missing_e2e_evidence',
      code: 'e2e_test_command_missing',
      artifact: '.mpl/state.json#finalize_done',
      reason: `[MPL AD-0008] required E2E scenario(s) missing executable test_command: ${missingCommand.join(', ')}.`,
      resumeInstruction: 'Emit executable test_command for every required E2E scenario, then retry finalize.',
      retryContext: { missing_command: missingCommand },
    });
  }
  const results = state?.e2e_results || {};
  const unresolved = [];
  for (const s of declaredRequired) {
    const r = results[s.id];
    if (!r) { unresolved.push(`${s.id} (never executed)`); continue; }
    if (r.exit_code !== 0) { unresolved.push(`${s.id} (exit ${r.exit_code})`); continue; }
  }
  if (unresolved.length > 0) {
    return block({
      ruleId: 'missing_e2e_evidence',
      code: 'e2e_scenarios_unresolved',
      artifact: '.mpl/state.json#finalize_done',
      reason: `[MPL AD-0008] ${unresolved.length} required E2E scenario(s) missing or failing: ${unresolved.join(', ')}.`,
      resumeInstruction: 'Re-execute each unresolved E2E scenario (or record an override), then retry finalize.',
      retryContext: { unresolved },
    });
  }
  return allow({ ruleId: 'missing_e2e_evidence', artifact: '.mpl/state.json#finalize_done' });
}

/**
 * AD-0008 R-2 E2E authenticity: mock-allowed / placeholder ban.
 */
export function handleE2eAuthenticity(ctx) {
  const { cwd, toolInput, config } = ctx;
  if (legacyRequiredFlag(config, 'e2e_authenticity_required', isConfigRequired(config, 'contracts.e2e_authenticity.required')) === false) {
    return allow({ ruleId: 'e2e_authenticity_invalid', artifact: '.mpl/state.json#finalize_done' });
  }
  if (!isFinalizeDoneWrite(toolInput)) return allow();

  const goal = readGoalContract(cwd);
  const policy = goal?.valid
    ? goal.contract.e2e_policy
    : { real_runtime_required: true, mock_allowed: false, placeholder_assertions_allowed: false };

  // Minimal authenticity check: when policy requires real runtime, require at least one scenario with runtime_class set.
  const text = readTextIfExists(cwd, '.mpl/mpl/e2e-scenarios.yaml');
  if (!text) {
    if (policy.real_runtime_required !== false) {
      return block({
        ruleId: 'e2e_authenticity_invalid',
        code: 'e2e_authenticity_invalid',
        artifact: '.mpl/state.json#finalize_done',
        reason: '[MPL E2E Authenticity] e2e-scenarios.yaml missing; real runtime required.',
        resumeInstruction: 'Emit .mpl/mpl/e2e-scenarios.yaml with real-runtime scenarios.',
        retryContext: { issues: ['e2e_scenarios_missing'] },
      });
    }
    return allow();
  }
  const REAL = new Set(['real_desktop', 'real_web', 'real_browser', 'real_mobile', 'real_api']);
  const MOCK = /\b(mock|stub|fake|msw|mockIPC|VITE_E2E_MOCK|__mocks__)\b/i;
  const issues = [];
  let cur = null;
  let listField = null;
  let listIndent = -1;
  const all = [];
  for (const line of text.split('\n').map((l) => l.replace(/\r$/, ''))) {
    const idMatch = line.match(/^\s*-\s+id:\s*["']?(E2E-[\w-]+)["']?/);
    if (idMatch) {
      if (cur) all.push(cur);
      cur = { id: idMatch[1], required: true, runtime_class: null, mock_allowed: null, test_command: null, test_files: [] };
      listField = null;
      continue;
    }
    if (!cur) continue;
    const scalar = line.match(/^\s+([a-zA-Z_][\w-]*)\s*:\s*(.+?)\s*$/);
    if (scalar) {
      const [, key, value] = scalar;
      if (key === 'required' || key === 'mock_allowed') {
        const v = value.trim().toLowerCase();
        cur[key] = v === 'true' ? true : (v === 'false' ? false : null);
      } else if (key in cur) {
        cur[key] = value.trim().replace(/^["']|["']$/g, '');
      }
      listField = null;
      continue;
    }
    const listStart = line.match(/^(\s+)(test_files|forbidden_patterns)\s*:\s*$/);
    if (listStart) { listIndent = listStart[1].length; listField = listStart[2]; continue; }
    if (listField) {
      const item = line.match(/^(\s*)-\s+(.+?)\s*$/);
      if (item && item[1].length > listIndent) {
        if (!Array.isArray(cur[listField])) cur[listField] = [];
        cur[listField].push(item[2].trim().replace(/^["']|["']$/g, ''));
        continue;
      }
      listField = null;
    }
  }
  if (cur) all.push(cur);

  const required = all.filter((s) => s.required !== false && s.test_command);
  if (policy.real_runtime_required !== false && required.length === 0) issues.push('required_e2e_scenario_missing');
  for (const s of required) {
    if (policy.real_runtime_required !== false && !REAL.has(s.runtime_class)) {
      issues.push(`${s.id}:runtime_class=${s.runtime_class || 'missing'}`);
    }
    if (policy.mock_allowed === false) {
      if (s.mock_allowed === true) issues.push(`${s.id}:mock_allowed=true`);
      if (MOCK.test(String(s.test_command || ''))) issues.push(`${s.id}:mock_token_in_command`);
    }
  }
  if (issues.length === 0) return allow({ ruleId: 'e2e_authenticity_invalid', artifact: '.mpl/state.json#finalize_done' });
  return block({
    ruleId: 'e2e_authenticity_invalid',
    code: 'e2e_authenticity_invalid',
    artifact: '.mpl/state.json#finalize_done',
    reason: `[MPL E2E Authenticity] required E2E evidence is not authentic: ${issues.join(', ')}.`,
    resumeInstruction: 'Replace mock/placeholder E2E substitutes with authentic real-runtime scenarios.',
    retryContext: { issues: issues.slice(0, 50) },
  });
}

/**
 * Finalize artifact closure: required artifacts + RUNBOOK + timestamps.
 */
export function handleFinalizeArtifacts(ctx) {
  const { cwd, toolInput, state, config } = ctx;
  if (legacyRequiredFlag(config, 'finalize_artifacts_required', isConfigRequired(config, 'contracts.finalize_artifacts.required')) === false) {
    return allow({ ruleId: 'missing_finalize_artifacts', artifact: '.mpl/state.json#finalize_done' });
  }
  if (!isFinalizeDoneWrite(toolInput)) return allow();

  const goal = readGoalContract(cwd);
  if (legacyRequiredFlag(config, 'goal_contract_required', true) !== false && (!goal.exists || !goal.valid)) {
    return block({
      ruleId: 'missing_finalize_artifacts',
      code: 'goal_contract_invalid',
      artifact: '.mpl/state.json#finalize_done',
      reason: `[MPL Goal Contract] goal contract missing or invalid: ${goal.missing.join(', ')}.`,
      resumeInstruction: 'Restore a valid .mpl/goal-contract.yaml, then retry finalize.',
      retryContext: { missing: goal.missing },
    });
  }

  const contract = goal.valid ? goal.contract : null;
  const required = contract?.completion_evidence?.required_artifacts?.length
    ? contract.completion_evidence.required_artifacts
    : defaultRequiredArtifacts();

  const missing = [];
  for (const rel of required) {
    if (!existsSync(join(cwd, rel))) missing.push(rel);
  }
  // RUNBOOK final section
  if (required.includes('.mpl/mpl/RUNBOOK.md')) {
    const runbook = readTextIfExists(cwd, '.mpl/mpl/RUNBOOK.md');
    if (!runbook || !/(^|\n)##\s+Pipeline Complete\b/.test(runbook)) {
      missing.push('.mpl/mpl/RUNBOOK.md#Pipeline Complete');
    }
  }
  // Finalize timestamps
  const requireTimestamps = contract?.completion_evidence?.require_finalize_timestamps !== false;
  if (requireTimestamps) {
    const writeText = (Array.isArray(toolInput?.edits) ? toolInput.edits : [toolInput]).map((e) =>
      [e?.new_string, e?.newString, e?.content].filter((x) => typeof x === 'string').join('\n')
    ).join('\n');
    if (!(typeof state?.completed_at === 'string' && state.completed_at.trim()) && !/"completed_at"\s*:\s*"[^"]+"/.test(writeText)) {
      missing.push('state.completed_at');
    }
    if (!(typeof state?.finalized_at === 'string' && state.finalized_at.trim()) && !/"finalized_at"\s*:\s*"[^"]+"/.test(writeText)) {
      missing.push('state.finalized_at');
    }
  }

  // Security evidence
  if (contract?.security_policy?.required === true) {
    const checks = contract.security_policy.checks || [];
    const report = readJsonIfExists(cwd, '.mpl/mpl/security-report.json');
    const stateResults = state?.security_results && typeof state.security_results === 'object' ? state.security_results : {};
    const isPass = (rec) => rec && (rec.exit_code === 0 || rec.verdict === 'pass' || rec.status === 'pass' || rec.status === 'PASS');
    if (checks.length === 0) {
      if (!isPass(report)) missing.push('security:report_or_checks');
    } else {
      for (const c of checks) {
        if (!isPass(stateResults[c]) && !isPass(report?.checks?.[c])) missing.push(`security:${c}`);
      }
    }
  }

  if (missing.length === 0) return allow({ ruleId: 'missing_finalize_artifacts', artifact: '.mpl/state.json#finalize_done' });
  return block({
    ruleId: 'missing_finalize_artifacts',
    code: 'finalize_artifacts_missing',
    artifact: '.mpl/state.json#finalize_done',
    reason: `[MPL Finalize Guard] missing completion evidence: ${missing.join(', ')}.`,
    resumeInstruction: 'Create the missing completion artifacts/evidence, then retry finalize.',
    retryContext: { missing },
  });
}

/**
 * Whole-goal closure: every decomposition phase must be complete and
 * its evidence must close the goal contract.
 */
export function handleWholeGoalClosure(ctx) {
  const { cwd, toolInput, state, config } = ctx;
  if (legacyRequiredFlag(config, 'whole_goal_closure_required', isConfigRequired(config, 'contracts.whole_goal_closure.required')) === false) {
    return allow({ ruleId: 'missing_whole_goal_closure', artifact: '.mpl/state.json#finalize_done' });
  }
  if (!isFinalizeDoneWrite(toolInput)) return allow();

  const goal = readGoalContract(cwd);
  if (legacyRequiredFlag(config, 'goal_contract_required', true) !== false && (!goal.exists || !goal.valid)) {
    return block({
      ruleId: 'missing_whole_goal_closure',
      code: 'goal_contract_invalid',
      artifact: '.mpl/state.json#finalize_done',
      reason: `[MPL Whole Goal Closure] goal contract missing or invalid: ${goal.missing.join(', ')}.`,
      resumeInstruction: 'Restore a valid .mpl/goal-contract.yaml (Phase 0 renewal).',
      retryContext: { missing: goal.missing },
    });
  }

  const allowPartial =
    state?.release?.cohort?.complete_pipeline_optional === true ||
    config?.release?.complete_pipeline_optional === true;

  const verdict = validateWholeGoalClosure({
    cwd,
    state,
    contract: goal.valid ? goal.contract : null,
    allowPartial,
  });
  if (verdict.valid) return allow({ ruleId: 'missing_whole_goal_closure', artifact: '.mpl/state.json#finalize_done' });
  const issues = verdict.issues || [];
  return block({
    ruleId: 'missing_whole_goal_closure',
    code: 'whole_goal_closure_missing',
    artifact: '.mpl/state.json#finalize_done',
    reason: `[MPL Whole Goal Closure] completed phase evidence does not close the Goal Contract: ${issues.slice(0, 12).join(', ')}${issues.length > 12 ? ` (+${issues.length - 12} more)` : ''}.`,
    resumeInstruction: 'Complete every decomposition phase and latch every Goal Contract AC/AX id, then retry finalize.',
    retryContext: { issues: issues.slice(0, 50) },
  });
}

// ============================================================================
// Top-level dispatch
// ============================================================================

const RULE_GROUPS = {
  finalize_done_state: [
    { name: 'e2e', handler: handleE2eGate, ruleKey: 'contracts.e2e.required' },
    { name: 'e2e_authenticity', handler: handleE2eAuthenticity, ruleKey: 'contracts.e2e_authenticity.required' },
    { name: 'finalize_artifacts', handler: handleFinalizeArtifacts, ruleKey: 'contracts.finalize_artifacts.required' },
    { name: 'whole_goal_closure', handler: handleWholeGoalClosure, ruleKey: 'contracts.whole_goal_closure.required' },
  ],
  decomposition_write: [
    { name: 'covers', handler: handleCovers, ruleKey: 'contracts.coverage.required' },
    { name: 'decomposition_delta', handler: handleDecompositionDelta, ruleKey: 'contracts.decomposition.require_delta' },
    { name: 'goal_trace', handler: handleGoalTrace, ruleKey: 'contracts.goal_trace.required' },
    { name: 'phase_contract_graph', handler: handlePhaseContractGraph, ruleKey: 'contracts.phase_contract_graph.required' },
    { name: 'reviewer', handler: handleReviewer, ruleKey: 'contracts.reviewer.required' },
  ],
  task_dispatch: [
    { name: 'chain_assignment', handler: handleChainAssignment, ruleKey: 'contracts.chain_assignment.required' },
    { name: 'test_agent_brief', handler: handleTestAgentBrief, ruleKey: 'contracts.test_agent.brief_required' },
    { name: 'test_agent_postrun', handler: handleTestAgentPostRun, ruleKey: 'contracts.test_agent.pass_required' },
  ],
};

function targetsDecomposition(toolInput) {
  if (!toolInput) return false;
  const paths = [];
  if (toolInput.file_path) paths.push(toolInput.file_path);
  if (toolInput.filePath) paths.push(toolInput.filePath);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      if (e?.file_path) paths.push(e.file_path);
      if (e?.filePath) paths.push(e.filePath);
    }
  }
  return paths.some((p) => /\.mpl\/mpl\/decomposition\.ya?ml$/.test(p));
}

function newlyCompletedPhaseIdsFromCtx(state, proposedState) {
  if (!proposedState || typeof proposedState !== 'object') return [];
  const previous = new Map(
    (state?.execution?.phase_details || []).map((p) => [p.id, p.status])
  );
  const out = [];
  for (const d of proposedState?.execution?.phase_details || []) {
    if (!d?.id) continue;
    if (d.status === 'completed' && previous.get(d.id) !== 'completed') out.push(d.id);
  }
  return out;
}

function mergeAllowDecisions(decisions) {
  const merged = allow();
  merged.classifications = decisions.map((d) => ({
    ruleId: d.ruleId,
    artifact: d.artifact,
  }));
  return merged;
}

/**
 * Top-level entrypoint. Routes by event + toolName + toolInput shape.
 *
 * @param {string} event — hook event name (PreToolUse | PostToolUse)
 * @param {object} ctx
 *   @param {string} ctx.cwd
 *   @param {object} ctx.state
 *   @param {object} [ctx.config]
 *   @param {string} ctx.toolName
 *   @param {string} [ctx.hookEvent]
 *   @param {object} [ctx.toolInput]
 *   @param {object} [ctx.raw]
 * @returns {Promise<object>} decision envelope (single, or `composite: [...]`)
 */
export async function handle(event, ctx = {}) {
  const merged = { ...ctx };
  const hookEvent = event || ctx.hookEvent || 'PreToolUse';
  const toolName = String(ctx.toolName || '');
  const toolInput = ctx.toolInput || {};

  // ----- Finalize cluster: finalize_done=true write to state.json -----
  if (isFinalizeDoneWrite(toolInput)) {
    const allowed = [];
    for (const rule of RULE_GROUPS.finalize_done_state) {
      const d = rule.handler(merged);
      if (d.action === 'block') return d;
      allowed.push(d);
    }
    return mergeAllowDecisions(allowed);
  }

  // ----- decomposition.yaml writes -----
  if (targetsDecomposition(toolInput)) {
    const allowed = [];
    for (const rule of RULE_GROUPS.decomposition_write) {
      // Reviewer is PostToolUse — skip on PreToolUse and vice versa.
      if (rule.name === 'reviewer' && hookEvent !== 'PostToolUse') continue;
      if (rule.name !== 'reviewer' && hookEvent === 'PostToolUse') continue;
      const d = rule.handler(merged);
      if (d.action === 'block') return d;
      allowed.push(d);
    }
    return mergeAllowDecisions(allowed);
  }

  // ----- Task/Agent dispatch -----
  if (['Task', 'Agent', 'task', 'agent'].includes(toolName)) {
    const sub = String(toolInput.subagent_type || toolInput.subagentType || '');
    if (['mpl-seed-generator', 'mpl:mpl-seed-generator'].includes(sub)) {
      return handleChainAssignment(merged);
    }
    if (/mpl-test-agent$/.test(sub) && hookEvent === 'PreToolUse') {
      return handleTestAgentBrief(merged);
    }
    if (/mpl-phase-runner$/.test(sub) && hookEvent === 'PostToolUse') {
      return handleTestAgentPostRun(merged);
    }
    return allow();
  }

  // ----- state.json transitions: per-phase evidence verification -----
  if (toolInput?.file_path && /\.mpl\/state\.json$/.test(String(toolInput.file_path))) {
    // Simulate the proposed state when possible.
    let proposed = null;
    try {
      if (toolName === 'Write' || toolName === 'write') {
        if (typeof toolInput.content === 'string') proposed = JSON.parse(toolInput.content);
      }
    } catch { /* ignore */ }
    if (proposed) {
      const newlyCompleted = newlyCompletedPhaseIdsFromCtx(ctx.state, proposed);
      for (const phaseId of newlyCompleted) {
        const verdict = verifyPhase(phaseId, {
          cwd: ctx.cwd,
          state: proposed,
          config: ctx.config,
        });
        if (!verdict.valid) {
          return block({
            ruleId: 'missing_phase_evidence',
            code: 'phase_evidence_latch_missing',
            artifact: `phase-evidence-latch:${phaseId}`,
            reason: `[MPL Phase Evidence] Phase ${phaseId} completion requires structural evidence: ${verdict.issues.slice(0, 12).join(', ')}.`,
            resumeInstruction: 'Produce structural evidence for every required token (state record, artifact, or schema), then retry.',
            retryContext: { phase_id: phaseId, issues: verdict.issues.slice(0, 50) },
          });
        }
      }
    }
    return allow();
  }

  return allow();
}
