/**
 * Minimal validator for decomposition.yaml as a phase contract graph.
 *
 * This validates the contract graph surface that is cheap to prove from the
 * prompt-controlled YAML subset: graph metadata, per-phase evidence/change
 * policy, and dangling `requires.from_phase` references.
 */

function normalizeScalar(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed.replace(/^["']|["']$/g, '').trim() || null;
}

function topScalar(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(text || '').match(new RegExp(`^${escaped}\\s*:\\s*(.+?)\\s*$`, 'm'));
  return m ? normalizeScalar(m[1]) : null;
}

function topLevelBlock(text, key) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^${escaped}\\s*:\\s*(.*)$`);
  const start = lines.findIndex((line) => startRe.test(line));
  if (start === -1) return null;

  const first = lines[start].match(startRe)?.[1]?.trim() || '';
  const out = [first];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function hasTopLevelNonEmptyField(text, key) {
  const block = topLevelBlock(text, key);
  if (block === null) return false;
  if (!block || block === '[]' || block === '{}' || block === 'null') return false;
  return block.split('\n').some((line) => line.trim() && line.trim() !== '[]' && line.trim() !== '{}');
}

function phaseBlocks(text) {
  const blocks = [];
  let cur = null;

  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };

  for (const line of String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))) {
    const idMatch = line.match(/^\s*-\s+id:\s*["']?(phase-[\w-]+)["']?/);
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

function hasField(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = block.match(new RegExp(`^\\s+${escaped}\\s*:`, 'm'));
  return Boolean(inline);
}

function hasNonEmptyField(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = block.match(new RegExp(`^\\s+${escaped}\\s*:\\s*(.+?)\\s*$`, 'm'));
  if (inline) {
    const value = inline[1].trim();
    if (value === '[]' || value === '{}' || value === 'null' || value === '""' || value === "''") return false;
    if (value) return true;
  }

  const nested = block.match(new RegExp(`^(\\s+)${escaped}\\s*:\\s*\\n((?:\\1\\s+.+\\n?)*)`, 'm'));
  if (!nested) return false;
  return nested[2].split('\n').some((line) => line.trim() && line.trim() !== '[]' && line.trim() !== '{}');
}

function extractRequiresFromPhases(block) {
  const out = [];
  const refs = String(block || '').matchAll(/^\s+(?:-\s+)?from_phase\s*:\s*["']?(phase-[\w-]+)["']?/gm);
  for (const ref of refs) out.push(ref[1]);
  return out;
}

function extractPhaseRefs(text) {
  const out = [];
  const refs = String(text || '').matchAll(/\bphase-[\w-]+\b/g);
  for (const ref of refs) out.push(ref[0]);
  return out;
}

export function parsePhaseContractGraphText(text) {
  const executionTiersBlock = topLevelBlock(text, 'execution_tiers');
  const phases = phaseBlocks(text).map((block) => ({
    id: block.id,
    has_evidence_required: hasNonEmptyField(block.text, 'evidence_required'),
    has_change_policy: hasNonEmptyField(block.text, 'change_policy'),
    has_resource_locks: hasField(block.text, 'resource_locks'),
    requires_from_phases: extractRequiresFromPhases(block.text),
  }));

  return {
    graph_version: topScalar(text, 'graph_version'),
    generated_by: topScalar(text, 'generated_by'),
    recompose_count: topScalar(text, 'recompose_count'),
    completed_phase_policy: topScalar(text, 'completed_phase_policy'),
    has_execution_tiers: hasTopLevelNonEmptyField(text, 'execution_tiers'),
    execution_tier_phase_refs: extractPhaseRefs(executionTiersBlock),
    phases,
  };
}

export function validatePhaseContractGraph(graph) {
  const issues = [];
  if (!graph?.graph_version) issues.push('graph_version:missing');
  if (graph?.generated_by !== 'mpl-decomposer') {
    issues.push(`generated_by:${graph?.generated_by || 'missing'}`);
  }
  if (graph?.recompose_count === null || graph?.recompose_count === undefined) {
    issues.push('recompose_count:missing');
  }
  if (!graph?.completed_phase_policy) issues.push('completed_phase_policy:missing');
  if (!graph?.has_execution_tiers) issues.push('execution_tiers:missing');
  if (!Array.isArray(graph?.phases) || graph.phases.length === 0) issues.push('phases:missing');

  const knownPhases = new Set((graph?.phases || []).map((p) => p.id));
  const tierPhaseRefs = graph?.execution_tier_phase_refs || [];
  const tierPhaseRefCounts = new Map();
  for (const phaseRef of tierPhaseRefs) {
    tierPhaseRefCounts.set(phaseRef, (tierPhaseRefCounts.get(phaseRef) || 0) + 1);
    if (!knownPhases.has(phaseRef)) issues.push(`execution_tiers:unknown:${phaseRef}`);
  }
  for (const [phaseRef, count] of tierPhaseRefCounts) {
    if (count > 1) issues.push(`execution_tiers:duplicate:${phaseRef}`);
  }

  for (const phase of graph?.phases || []) {
    if (!phase.has_evidence_required) issues.push(`${phase.id}:evidence_required:missing`);
    if (!phase.has_change_policy) issues.push(`${phase.id}:change_policy:missing`);
    if (!phase.has_resource_locks) issues.push(`${phase.id}:resource_locks:missing`);
    if (graph?.has_execution_tiers && !tierPhaseRefCounts.has(phase.id)) {
      issues.push(`${phase.id}:execution_tiers:missing`);
    }
    for (const fromPhase of phase.requires_from_phases || []) {
      if (fromPhase === phase.id) issues.push(`${phase.id}:requires:self:${fromPhase}`);
      else if (!knownPhases.has(fromPhase)) issues.push(`${phase.id}:requires:unknown:${fromPhase}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
