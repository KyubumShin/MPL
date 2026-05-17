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

export function parsePhaseContractGraphText(text) {
  const phases = phaseBlocks(text).map((block) => ({
    id: block.id,
    has_evidence_required: hasNonEmptyField(block.text, 'evidence_required'),
    has_change_policy: hasNonEmptyField(block.text, 'change_policy'),
    requires_from_phases: extractRequiresFromPhases(block.text),
  }));

  return {
    graph_version: topScalar(text, 'graph_version'),
    generated_by: topScalar(text, 'generated_by'),
    recompose_count: topScalar(text, 'recompose_count'),
    completed_phase_policy: topScalar(text, 'completed_phase_policy'),
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
  if (!Array.isArray(graph?.phases) || graph.phases.length === 0) issues.push('phases:missing');

  const knownPhases = new Set((graph?.phases || []).map((p) => p.id));
  for (const phase of graph?.phases || []) {
    if (!phase.has_evidence_required) issues.push(`${phase.id}:evidence_required:missing`);
    if (!phase.has_change_policy) issues.push(`${phase.id}:change_policy:missing`);
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
