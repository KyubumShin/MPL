/**
 * Stage A Phase 1.6c-ii release-manifest serialization helpers.
 *
 * Builds the three artifacts written at `release-finalize` exit (per RFC §5.4):
 *
 *   .mpl/mpl/releases/{cut_id}/release-manifest.json   — structured manifest
 *   .mpl/mpl/releases/{cut_id}/evidence-summary.md     — human summary
 *   .mpl/mpl/releases/{cut_id}/gate-results.json       — archival copy of
 *                                                        state.release.gate_results
 *
 * Snapshot identifiers (`commit_sha`, `tree_sha`, `snapshot_ref`) are written
 * as placeholders (`null`) here; 1.6c-iii will populate them via
 * `git rev-parse` / `git update-ref`. The contract surface stays stable so
 * 1.6c-iii's diff is small (it only fills the placeholders).
 *
 * Pure functions: every helper takes its inputs explicitly and returns a
 * value. No filesystem I/O lives in this module — the caller (phase-controller
 * release-finalize handler) decides where and when to persist.
 */

export const RELEASE_DIR_REL_PATH = '.mpl/mpl/releases';

/**
 * Resolve which cut object describes the cohort being released.
 *
 * Stage A: when `cutId === 'mvp'`, source REQUIRES both `graph.mvp`
 * (decomposer-derived, see PR #182) AND `contract.mvp_scope`. The two
 * artifacts describe different facets of the cohort — graph carries the
 * mechanically-derived `phases[]` membership, contract carries the
 * user-declared `acceptance_criteria` / `variation_axes` goal trace.
 * Allowing one without the other lets a degraded manifest with empty
 * phases (or missing goal_trace) ship and silently flip D-Q6 immutability
 * for a cut that never had a real phase set. **Both must be present and
 * `graph.mvp.phases` must be non-empty.** Returns `null` when either side
 * is missing or phases are empty — the caller refuses to advance the
 * lifecycle (PR #187 codex review).
 *
 * When `cutId` matches a `release_cuts[].id`, source is that entry.
 *
 * @param {string} cutId
 * @param {object|null} contract - parsed goal contract (parseGoalContractText)
 * @param {object|null} graph    - parsed phase-contract-graph (parsePhaseContractGraphText)
 * @returns {{ phases: string[], artifact: string|null,
 *             acceptance_criteria: string[], variation_axes: string[] } | null}
 */
export function resolveCutDescriptor(cutId, contract, graph) {
  if (typeof cutId !== 'string' || !cutId) return null;

  if (cutId === 'mvp') {
    const mvpGraph = graph?.mvp;
    const mvpScope = contract?.mvp_scope;
    // Strict: both sides required (RFC §5.4 — manifest must carry both
    // phase membership AND goal trace). PR #187 codex review caught the
    // prior OR logic that silently shipped phases:[] manifests.
    if (!mvpGraph || !mvpScope) return null;
    const phases = Array.isArray(mvpGraph.phases) ? [...mvpGraph.phases] : [];
    // Empty phases means the decomposer never derived an mvp membership
    // (mechanical id-set mapping yielded nothing); shipping such a
    // manifest would assert "this cut is released" while listing no
    // work — refuse.
    if (phases.length === 0) return null;
    return {
      phases,
      artifact:
        // Stage A: the decomposer mechanically copies mvp_scope.artifact
        // into graph.mvp.artifact (PR #182). Prefer the graph entry — it's
        // the canonical mechanically-derived value. Fall back to the
        // contract scope when the graph entry is missing (e.g., legacy
        // decomposition predates 1.2).
        mvpGraph.artifact ?? mvpScope.artifact ?? null,
      acceptance_criteria: Array.isArray(mvpScope.acceptance_criteria)
        ? [...mvpScope.acceptance_criteria]
        : [],
      variation_axes: Array.isArray(mvpScope.variation_axes)
        ? [...mvpScope.variation_axes]
        : [],
    };
  }

  const releaseCuts = Array.isArray(graph?.release_cuts) ? graph.release_cuts : [];
  const found = releaseCuts.find((c) => c?.id === cutId);
  if (!found) return null;
  const phases = Array.isArray(found.phases) ? [...found.phases] : [];
  // Same empty-phases guard as the mvp branch.
  if (phases.length === 0) return null;
  return {
    phases,
    artifact: found.artifact ?? null,
    // Auto-pick-up if Stage B extends `release_cuts[]` with goal_trace
    // fields (claude review #4 on PR #187). One-character defense lets
    // the resolver stay correct without a future code change.
    acceptance_criteria: Array.isArray(found.acceptance_criteria)
      ? [...found.acceptance_criteria]
      : [],
    variation_axes: Array.isArray(found.variation_axes)
      ? [...found.variation_axes]
      : [],
  };
}

/**
 * Build the release-manifest.json payload for a cohort.
 *
 * Snapshot identifiers are placeholder `null` values pending 1.6c-iii.
 * Gate-results summary is a compact { hard1, hard2, hard3 } boolean view
 * derived from `state.release.gate_results.hard{1,2,3}_{baseline,coverage,resilience}`
 * exit codes (0 → true, nonzero → false, absent → null).
 *
 * @param {{ cutId: string, state: object, contract: object|null,
 *           graph: object|null, now?: string }} opts
 * @returns {object|null} manifest object, or null when cut descriptor is missing
 */
export function buildReleaseManifest({ cutId, state, contract, graph, now }) {
  const descriptor = resolveCutDescriptor(cutId, contract, graph);
  if (!descriptor) return null;

  const release = state?.release || {};
  const gateResults = release.gate_results || {};

  return {
    cut_id: cutId,
    phases: descriptor.phases,
    goal_trace: {
      acceptance_criteria: descriptor.acceptance_criteria,
      variation_axes: descriptor.variation_axes,
    },
    // 1.6c-iii will populate these via `git rev-parse HEAD`, `git rev-parse
    // HEAD^{tree}`, and `git update-ref refs/mpl/releases/{cut_id}`.
    // Placeholder shape is fixed so the manifest schema is stable across
    // the 1.6c-ii → 1.6c-iii boundary.
    commit_sha: null,
    tree_sha: null,
    snapshot_ref: null,
    gate_results_summary: summarizeGateResults(gateResults),
    artifact: descriptor.artifact,
    // Optional fault state. 1.6c-iii sets this on git/gh failure; 1.6c-ii
    // always writes null because no artifact creation happens here.
    artifact_creation_failed: null,
    created_at: now || new Date().toISOString(),
    pipeline_id: state?.pipeline_id || null,
  };
}

/**
 * Boolean view of release-scoped Hard 1/2/3 evidence.
 * Mirrors the per-gate convention in `checkGateResults` / phase-controller:
 *   0   → true (PASS)
 *   ≠0  → false (FAIL)
 *   absent / non-numeric → null (not recorded)
 */
function summarizeGateResults(gates) {
  const out = { hard1: null, hard2: null, hard3: null };
  const pairs = [
    ['hard1', 'hard1_baseline'],
    ['hard2', 'hard2_coverage'],
    ['hard3', 'hard3_resilience'],
  ];
  for (const [short, structuredKey] of pairs) {
    const entry = gates?.[structuredKey];
    if (entry && typeof entry === 'object' && typeof entry.exit_code === 'number') {
      out[short] = entry.exit_code === 0;
    }
  }
  return out;
}

/**
 * Take a release-scoped snapshot of `state.release.gate_results` for archival.
 *
 * Pure structural copy — no transformation. Returns `{ hard{1,2,3}_passed,
 * hard{1,2,3}_{baseline,coverage,resilience} }` matching the in-state shape
 * so users can diff the file against state.json directly. Captures the
 * recording timestamp so the archived file is self-dating.
 */
export function buildGateResultsSnapshot(state, now) {
  const gates = state?.release?.gate_results || {};
  // structuredClone (not spread) so any nested object inside an entry
  // — e.g., a future `{ exit_code: 0, details: { ... } }` shape — is
  // isolated from the source. Today's flat shape works with shallow
  // copy, but the future-proofing is a one-liner (claude review #3 on
  // PR #187).
  const clone = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    return structuredClone(entry);
  };
  return {
    archived_at: now || new Date().toISOString(),
    gate_results: {
      hard1_passed: gates.hard1_passed ?? null,
      hard2_passed: gates.hard2_passed ?? null,
      hard3_passed: gates.hard3_passed ?? null,
      hard1_baseline: clone(gates.hard1_baseline),
      hard2_coverage: clone(gates.hard2_coverage),
      hard3_resilience: clone(gates.hard3_resilience),
    },
  };
}

/**
 * Human-readable evidence summary as Markdown.
 *
 * Sections:
 *   1. Cohort header (cut_id, artifact, created_at)
 *   2. Phases — list of phase ids in this cut, with status from
 *      `state.execution.phase_details[]` when available
 *   3. Goal trace — acceptance_criteria + variation_axes covered
 *   4. Gate results — Hard 1/2/3 PASS/FAIL/missing (release-scoped)
 *   5. Test-agent dispatches — phase id → verdict + tests_total when present
 *
 * Avoid leaking long stdout_tail blocks; this file is for skimming, not
 * full forensics. The full evidence is preserved in `gate-results.json`
 * alongside it.
 */
export function buildEvidenceSummary({ cutId, state, contract, graph, now }) {
  const descriptor = resolveCutDescriptor(cutId, contract, graph) || {
    phases: [], artifact: null, acceptance_criteria: [], variation_axes: [],
  };
  const release = state?.release || {};
  const gates = release.gate_results || {};
  const phaseDetails = Array.isArray(state?.execution?.phase_details)
    ? state.execution.phase_details
    : [];
  const phaseStatus = new Map();
  for (const p of phaseDetails) {
    if (p?.id) phaseStatus.set(p.id, p.status || 'unknown');
  }

  const lines = [];
  lines.push(`# Release evidence — \`${cutId}\``);
  lines.push('');
  lines.push(`- **Created:** ${now || new Date().toISOString()}`);
  lines.push(`- **Pipeline:** ${state?.pipeline_id || '(unknown)'}`);
  lines.push(`- **Artifact:** ${descriptor.artifact || '(none requested)'}`);
  lines.push('');

  lines.push('## Phases');
  if (descriptor.phases.length === 0) {
    lines.push('_No phases recorded for this cut._');
  } else {
    for (const id of descriptor.phases) {
      const status = phaseStatus.get(id) || '(no execution record)';
      lines.push(`- \`${id}\` — ${status}`);
    }
  }
  lines.push('');

  lines.push('## Goal trace');
  lines.push(`- Acceptance criteria: ${formatIdList(descriptor.acceptance_criteria)}`);
  lines.push(`- Variation axes: ${formatIdList(descriptor.variation_axes)}`);
  lines.push('');

  lines.push('## Gate results (release-scoped)');
  const summary = summarizeGateResults(gates);
  lines.push(`- Hard 1 (build/lint/type): ${formatGate(summary.hard1, gates.hard1_baseline)}`);
  lines.push(`- Hard 2 (tests): ${formatGate(summary.hard2, gates.hard2_coverage)}`);
  lines.push(`- Hard 3 (contracts): ${formatGate(summary.hard3, gates.hard3_resilience)}`);
  lines.push('');

  lines.push('## Test-agent dispatches');
  const dispatches = state?.test_agent_dispatched || {};
  const cohortDispatches = descriptor.phases
    .map((id) => [id, dispatches[id]])
    .filter(([, d]) => d && typeof d === 'object');
  if (cohortDispatches.length === 0) {
    lines.push('_No test-agent evidence recorded for this cohort._');
  } else {
    for (const [id, d] of cohortDispatches) {
      const verdict = d.verdict || '(no verdict)';
      const total = typeof d.tests_total === 'number' ? d.tests_total : '?';
      const failed = typeof d.tests_failed === 'number' ? d.tests_failed : '?';
      lines.push(`- \`${id}\` — verdict=${verdict}, tests=${total} (failed=${failed})`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function formatIdList(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return '_(none recorded)_';
  return ids.map((id) => `\`${id}\``).join(', ');
}

function formatGate(boolish, entry) {
  if (boolish === true) return '✅ PASS';
  if (boolish === false) {
    const code = entry && typeof entry.exit_code === 'number' ? ` (exit ${entry.exit_code})` : '';
    return `❌ FAIL${code}`;
  }
  return '— not recorded';
}
