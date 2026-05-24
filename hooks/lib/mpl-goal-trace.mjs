/**
 * Goal trace validation for `.mpl/mpl/decomposition.yaml`.
 *
 * The parser intentionally supports the prompt-controlled YAML subset emitted
 * by `mpl-decomposer`: top-level `goal_contract_hash`, phase list entries, and
 * `goal_trace` arrays in inline or block-list form.
 */

function normalizeScalar(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed.replace(/^["']|["']$/g, '').trim() || null;
}

function parseInlineList(value) {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((s) => normalizeScalar(s))
    .filter(Boolean);
}

function indentOf(line) {
  const m = String(line || '').match(/^(\s*)/);
  return m ? m[1].length : 0;
}

export function parseDecompositionGoalTraceText(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const phases = [];
  let goalContractHash = null;
  let cur = null;
  let inGoalTrace = false;
  let goalTraceIndent = -1;
  let listField = null;
  let listIndent = -1;

  const flush = () => {
    if (!cur) return;
    phases.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const hashMatch = line.match(/^goal_contract_hash\s*:\s*["']?([^"'\s#]+)["']?/);
    if (hashMatch) {
      goalContractHash = hashMatch[1];
      continue;
    }

    const idMatch = line.match(/^\s*-\s+id:\s*["']?(phase-[\w-]+)["']?/);
    if (idMatch) {
      flush();
      cur = {
        id: idMatch[1],
        has_goal_trace: false,
        acceptance_criteria: [],
        variation_axes: [],
        ontology_entities: [],
      };
      inGoalTrace = false;
      listField = null;
      continue;
    }
    if (!cur) continue;

    const gtMatch = line.match(/^(\s+)goal_trace\s*:\s*$/);
    if (gtMatch) {
      cur.has_goal_trace = true;
      inGoalTrace = true;
      goalTraceIndent = gtMatch[1].length;
      listField = null;
      continue;
    }

    if (inGoalTrace && line.trim() && indentOf(line) <= goalTraceIndent) {
      inGoalTrace = false;
      listField = null;
    }
    if (!inGoalTrace) continue;

    const fieldMatch = line.match(/^(\s+)(acceptance_criteria|variation_axes|ontology_entities)\s*:\s*(.*?)\s*$/);
    if (fieldMatch) {
      const [, spaces, field, value] = fieldMatch;
      const parsed = parseInlineList(value);
      if (parsed) {
        cur[field] = parsed;
        listField = null;
      } else if (value.trim()) {
        const scalar = normalizeScalar(value);
        cur[field] = scalar ? [scalar] : [];
        listField = null;
      } else {
        cur[field] = [];
        listField = field;
        listIndent = spaces.length;
      }
      continue;
    }

    if (listField) {
      const itemMatch = line.match(/^(\s*)-\s+(.+?)\s*$/);
      if (itemMatch && itemMatch[1].length > listIndent) {
        const item = normalizeScalar(itemMatch[2]);
        if (item) cur[listField].push(item);
        continue;
      }
      if (line.trim()) listField = null;
    }
  }
  flush();

  return {
    goal_contract_hash: goalContractHash,
    phases,
  };
}

function difference(required, actual) {
  const actualSet = new Set(actual);
  return required.filter((id) => !actualSet.has(id));
}

function unknown(actual, allowed) {
  const allowedSet = new Set(allowed);
  return actual.filter((id) => !allowedSet.has(id));
}

export function validateGoalTraceCoverage(decomposition, contract) {
  const issues = [];
  const phases = decomposition?.phases || [];
  const goalHash = contract?.content_sha256 || null;
  const requiredAc = contract?.acceptance_criteria || [];
  const requiredAx = contract?.variation_axes || [];
  const allowedEntities = contract?.ontology?.entities || [];

  if (!decomposition?.goal_contract_hash) {
    issues.push('goal_contract_hash:missing');
  } else if (goalHash && decomposition.goal_contract_hash !== goalHash) {
    issues.push(`goal_contract_hash:mismatch:${decomposition.goal_contract_hash}->${goalHash}`);
  }

  if (phases.length === 0) issues.push('phases:missing');

  const allAc = [];
  const allAx = [];
  const allEntities = [];
  for (const phase of phases) {
    const phaseRefs = [
      ...(phase.acceptance_criteria || []),
      ...(phase.variation_axes || []),
      ...(phase.ontology_entities || []),
    ];
    if (!phase.has_goal_trace) {
      issues.push(`${phase.id}:goal_trace:missing`);
    } else if (phaseRefs.length === 0) {
      issues.push(`${phase.id}:goal_trace:empty`);
    }
    allAc.push(...(phase.acceptance_criteria || []));
    allAx.push(...(phase.variation_axes || []));
    allEntities.push(...(phase.ontology_entities || []));
  }

  for (const id of difference(requiredAc, allAc)) issues.push(`acceptance_criteria:uncovered:${id}`);
  for (const id of difference(requiredAx, allAx)) issues.push(`variation_axes:uncovered:${id}`);
  for (const id of unknown([...new Set(allAc)], requiredAc)) issues.push(`acceptance_criteria:unknown:${id}`);
  for (const id of unknown([...new Set(allAx)], requiredAx)) issues.push(`variation_axes:unknown:${id}`);
  if (allowedEntities.length > 0) {
    for (const id of unknown([...new Set(allEntities)], allowedEntities)) {
      issues.push(`ontology_entities:unknown:${id}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Stage A RFC §4.2 — MVP cohort goal_trace subset coverage.
 *
 * The whole-pipeline validator above checks that the UNION of every
 * phase's `goal_trace` covers `contract.acceptance_criteria` /
 * `contract.variation_axes`. That guard is necessary but not sufficient
 * when `goal_contract.mvp_scope` declares a cohort: the cohort manifest
 * shipped at `release-finalize` carries `goal_trace.acceptance_criteria`
 * / `variation_axes` derived solely from `mvp_scope`, and the
 * decomposer is supposed to assign at least one MVP phase that covers
 * each MVP AC/AX. Without this validator the whole-pipeline coverage
 * could pass while the MVP subset (phases referenced by
 * `graph.mvp.phases`) leaves some MVP AC/AX uncovered — a
 * "released" cohort would then ship a manifest claiming coverage of
 * an AC/AX that no phase actually delivered, flipping D-Q6
 * immutability for a partial cohort. The post-Stage-A audit caught this
 * as a spec gap.
 *
 * Skip when no MVP cohort is declared (contract.mvp_scope is null) —
 * the whole-pipeline validator already handles non-cohort flows.
 *
 * @param {object} decomposition - parsed by parseDecompositionGoalTraceText
 * @param {object} contract      - parsed by parseGoalContractText
 * @param {object} graph         - parsed by parsePhaseContractGraphText (carries graph.mvp.phases)
 */
export function validateMvpGoalTraceCoverage(decomposition, contract, graph) {
  const issues = [];
  const mvpScope = contract?.mvp_scope;
  if (!mvpScope) return { valid: true, issues };

  const mvpPhaseIds = Array.isArray(graph?.mvp?.phases) ? graph.mvp.phases : [];
  // Empty mvp.phases is caught by mpl-require-phase-contract-graph (B5
  // dependency-closure rule + resolveCutDescriptor empty-phases guard).
  // Don't double-report here.
  if (mvpPhaseIds.length === 0) return { valid: true, issues };

  const mvpPhaseSet = new Set(mvpPhaseIds);
  const requiredAc = Array.isArray(mvpScope.acceptance_criteria) ? mvpScope.acceptance_criteria : [];
  const requiredAx = Array.isArray(mvpScope.variation_axes) ? mvpScope.variation_axes : [];

  const mvpAc = [];
  const mvpAx = [];
  for (const phase of (decomposition?.phases || [])) {
    if (!mvpPhaseSet.has(phase.id)) continue;
    mvpAc.push(...(phase.acceptance_criteria || []));
    mvpAx.push(...(phase.variation_axes || []));
  }

  for (const id of difference(requiredAc, mvpAc)) issues.push(`mvp_scope.acceptance_criteria:uncovered:${id}`);
  for (const id of difference(requiredAx, mvpAx)) issues.push(`mvp_scope.variation_axes:uncovered:${id}`);

  return {
    valid: issues.length === 0,
    issues,
  };
}
