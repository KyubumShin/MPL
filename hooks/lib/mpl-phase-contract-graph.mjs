/**
 * Minimal validator for decomposition.yaml as a phase contract graph.
 *
 * This validates the contract graph surface that is cheap to prove from the
 * prompt-controlled YAML subset: graph metadata, per-phase evidence/change
 * policy, dangling `requires.from_phase` references, and Stage A
 * `mvp` / `release_cuts[]` schema integrity.
 */

export const ALLOWED_RELEASE_ARTIFACTS = Object.freeze([
  'draft_pr',
  'branch',
  'tag',
  'release_manifest',
]);

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

function inlineListItems(block, key) {
  if (!block) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = block.match(new RegExp(`^\\s*${escaped}\\s*:\\s*\\[(.*)\\]\\s*$`, 'm'));
  if (inline) {
    return inline[1]
      .split(',')
      .map((s) => normalizeScalar(s))
      .filter(Boolean);
  }
  // block-list form
  const nestedMatch = block.match(new RegExp(`^(\\s*)${escaped}\\s*:\\s*\\n((?:\\1\\s+-\\s+.+\\n?)+)`, 'm'));
  if (!nestedMatch) return null;
  const items = [];
  for (const line of nestedMatch[2].split('\n')) {
    const m = line.match(/^\s*-\s+(.+?)\s*$/);
    if (m) items.push(normalizeScalar(m[1]));
  }
  return items.filter(Boolean);
}

function nestedScalar(block, key) {
  if (!block) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`^\\s+${escaped}\\s*:\\s*(.+?)\\s*$`, 'm'));
  return m ? normalizeScalar(m[1]) : null;
}

function parseMvpObject(text) {
  if (!/^mvp\s*:/m.test(text)) return null;
  const block = topLevelBlock(text, 'mvp');
  if (block === null) return null;
  return {
    phases: inlineListItems(block, 'phases') || [],
    execution_mode: nestedScalar(block, 'execution_mode'),
    artifact: nestedScalar(block, 'artifact'),
    derived_from: nestedScalar(block, 'derived_from'),
  };
}

function parseReleaseCuts(text) {
  if (!/^release_cuts\s*:/m.test(text)) return null;
  const block = topLevelBlock(text, 'release_cuts');
  if (block === null) return null;

  // Split into `-` item blocks first, then extract `id` from anywhere inside
  // the block — YAML mapping field order is not significant, so `id` may
  // legitimately appear after `phases:`, `artifact:`, etc.
  const itemBlocks = [];
  let cur = null;

  const flush = () => {
    if (cur) itemBlocks.push(cur.join('\n'));
    cur = null;
  };

  for (const line of block.split('\n')) {
    const itemStart = line.match(/^(\s*)-\s+(.+?)\s*$/);
    if (itemStart) {
      flush();
      // Replace `- ` with equivalent whitespace so the first line of each item
      // is a normal indented `key: value` line that nestedScalar/inlineListItems
      // (both anchored on `\s+`) can match.
      cur = [`${itemStart[1]}  ${itemStart[2]}`];
      continue;
    }
    if (cur) cur.push(line);
  }
  flush();

  const cuts = [];
  for (const itemText of itemBlocks) {
    const idMatch = itemText.match(/(?:^|\n)\s*id\s*:\s*["']?([^"'\s#]+)["']?/);
    cuts.push({
      id: idMatch ? idMatch[1] : null,
      phases: inlineListItems(itemText, 'phases') || [],
      user_approved: (() => {
        const raw = nestedScalar(itemText, 'user_approved');
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        return null;
      })(),
      artifact: nestedScalar(itemText, 'artifact'),
    });
  }
  return cuts;
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
    mvp: parseMvpObject(text),
    release_cuts: parseReleaseCuts(text),
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

  validateMvpAndReleaseCuts(graph, knownPhases, issues);

  return {
    valid: issues.length === 0,
    issues,
  };
}

function validateMvpAndReleaseCuts(graph, knownPhases, issues) {
  const mvp = graph?.mvp;
  const cuts = graph?.release_cuts;

  // Both fields are optional at this layer: a project without Stage A `mvp_scope`
  // emits no `mvp`/`release_cuts`, and the existing pipeline continues unchanged.
  // The "iff goal_contract.mvp_scope present → mvp required" check lives at the
  // goal-contract / hook integration layer, not here.

  if (mvp) {
    if (!Array.isArray(mvp.phases) || mvp.phases.length === 0) {
      issues.push('mvp:phases:missing');
    } else {
      for (const phaseId of mvp.phases) {
        if (!knownPhases.has(phaseId)) issues.push(`mvp:phases:unknown:${phaseId}`);
      }
      const seen = new Set();
      for (const phaseId of mvp.phases) {
        if (seen.has(phaseId)) issues.push(`mvp:phases:duplicate:${phaseId}`);
        seen.add(phaseId);
      }
    }
    if (mvp.execution_mode === null) {
      issues.push('mvp:execution_mode:missing');
    } else if (mvp.execution_mode !== 'sequential') {
      // Stage A: contract_skeleton is reserved for Stage B and rejected here.
      issues.push(`mvp:execution_mode:unsupported:${mvp.execution_mode}`);
    }
    if (mvp.artifact === null) {
      issues.push('mvp:artifact:missing');
    } else if (!ALLOWED_RELEASE_ARTIFACTS.includes(mvp.artifact)) {
      issues.push(`mvp:artifact:unsupported:${mvp.artifact}`);
    }
  }

  if (Array.isArray(cuts)) {
    const cutIds = new Set();
    const phaseToCut = new Map();
    if (mvp?.phases) {
      for (const p of mvp.phases) phaseToCut.set(p, 'mvp');
    }
    for (const cut of cuts) {
      if (!cut.id) {
        issues.push('release_cuts:id:missing');
        continue;
      }
      if (cutIds.has(cut.id)) {
        issues.push(`release_cuts:id:duplicate:${cut.id}`);
        continue;
      }
      cutIds.add(cut.id);

      if (cut.id === 'mvp') {
        issues.push('release_cuts:id:reserved:mvp');
      }
      if (!Array.isArray(cut.phases) || cut.phases.length === 0) {
        issues.push(`release_cuts:${cut.id}:phases:missing`);
      } else {
        for (const phaseId of cut.phases) {
          if (!knownPhases.has(phaseId)) {
            issues.push(`release_cuts:${cut.id}:phases:unknown:${phaseId}`);
          }
          const existingOwner = phaseToCut.get(phaseId);
          if (existingOwner) {
            issues.push(`release_cuts:${cut.id}:phases:overlap:${phaseId}:already_in:${existingOwner}`);
          } else {
            phaseToCut.set(phaseId, cut.id);
          }
        }
      }
      if (cut.user_approved === null) {
        issues.push(`release_cuts:${cut.id}:user_approved:missing`);
      }
      if (cut.artifact === null) {
        // Default applied at decomposer layer; allow absent here but flag explicitly
        // to keep the schema honest — decomposer should emit it.
        issues.push(`release_cuts:${cut.id}:artifact:missing`);
      } else if (!ALLOWED_RELEASE_ARTIFACTS.includes(cut.artifact)) {
        issues.push(`release_cuts:${cut.id}:artifact:unsupported:${cut.artifact}`);
      }
    }
  }
}
