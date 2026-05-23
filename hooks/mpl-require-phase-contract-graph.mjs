#!/usr/bin/env node
/**
 * MPL Require Phase Contract Graph Hook (PreToolUse on Write|Edit|MultiEdit).
 *
 * Blocks decomposition writes when the file is only a task list instead of a
 * contract graph: missing graph metadata, missing phase evidence/change policy,
 * or dangling phase dependencies.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { parsePhaseContractGraphText, validatePhaseContractGraph } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-phase-contract-graph.mjs')).href
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

export function targetsDecompositionFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(filePath);
}

function collectDecompositionTexts(toolInput) {
  return collectFileWrites(toolInput)
    .filter((entry) => targetsDecompositionFile(entry.filePath) && entry.text)
    .map((entry) => entry.text);
}

function readCompletedCutIds(cwd) {
  // Returns the set of cut ids whose `release-finalize` has shipped.
  //
  // SHAPE COMMITMENT — Phase 1.6 must align with this consumer:
  //   state.release.completed_cut_ids: string[]
  //
  // The path/shape is defined by RFC §4.5 (state.release subtree) and by
  // PR #179's Rule 9 extension that references the same set. When Phase 1.6
  // lands the writer, the schema MUST emit a flat `string[]` so the diff
  // below remains a single hash-set lookup. Any richer audit trail (e.g.,
  // per-cut finalized_at timestamps) must live in a sibling field so this
  // consumer keeps working unchanged. If Phase 1.6 needs to evolve the
  // shape, update this consumer first or both atomically.
  //
  // Until Phase 1.6 lands, the field is absent and we return an empty set
  // — the immutability check below becomes a no-op for graphs whose state
  // doesn't yet carry release lifecycle data.
  const path = join(cwd, '.mpl', 'state.json');
  if (!existsSync(path)) return new Set();
  try {
    const text = readFileSync(path, 'utf-8');
    const state = JSON.parse(text);
    const ids = state?.release?.completed_cut_ids;
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.filter((id) => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function readExistingDecomposition(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function cutPhasesById(graph) {
  // Return Map<cut_id_or_"mvp", string[] of phase ids in declared order>.
  const out = new Map();
  if (graph?.mvp?.phases) out.set('mvp', [...graph.mvp.phases]);
  if (Array.isArray(graph?.release_cuts)) {
    for (const cut of graph.release_cuts) {
      if (cut?.id) out.set(cut.id, Array.isArray(cut.phases) ? [...cut.phases] : []);
    }
  }
  return out;
}

function phasesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function validateReleasedCutImmutability(cwd, newGraph) {
  // RFC §10 D-Q6: once a cut id is in state.release.completed_cut_ids, its
  // phase membership is frozen. The corresponding release-manifest has been
  // shipped externally; mutating the phase list would invalidate the artifact.
  // Pre-release iteration (cut id NOT yet in completed_cut_ids) remains free.
  const completed = readCompletedCutIds(cwd);
  if (completed.size === 0) return []; // no released cuts → nothing to enforce

  const existingText = readExistingDecomposition(cwd);
  if (!existingText) return []; // no prior graph to compare against → first write

  const existingGraph = parsePhaseContractGraphText(existingText);
  const oldCutPhases = cutPhasesById(existingGraph);
  const newCutPhases = cutPhasesById(newGraph);

  const issues = [];
  for (const cutId of completed) {
    const oldPhases = oldCutPhases.get(cutId);
    const newPhases = newCutPhases.get(cutId);
    // Intentionally silent on `oldPhases === undefined`: a released cut id
    // listed in state but missing from the prior decomposition is a
    // state↔graph drift signal that should be diagnosed by a separate
    // consistency check, not this immutability hook. This hook's job is
    // mutation-detection on a present-on-both-sides cut — it cannot diff
    // what it cannot see. Surfacing it here would block legitimate graph
    // repairs after a recompose where the cut entry was already lost.
    if (oldPhases === undefined) continue;
    if (newPhases === undefined) {
      issues.push(`released_cut:${cutId}:removed_from_graph`);
      continue;
    }
    if (!phasesEqual(oldPhases, newPhases)) {
      issues.push(`released_cut:${cutId}:phases:mutated:old=[${oldPhases.join(',')}]:new=[${newPhases.join(',')}]`);
    }
  }
  return issues;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  const texts = collectDecompositionTexts(toolInput);
  if (texts.length === 0) return ok();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const cfg = loadConfig(cwd);
  if (cfg.phase_contract_graph_required === false) return ok();

  const issues = [];
  for (const text of texts) {
    const graph = parsePhaseContractGraphText(text);
    const verdict = validatePhaseContractGraph(graph);
    issues.push(...verdict.issues);
    // D-Q6 released-cut immutability — only meaningful once state.release
    // exists (Phase 1.6+). Returns [] today for graphs whose state.json
    // lacks `state.release.completed_cut_ids`.
    issues.push(...validateReleasedCutImmutability(cwd, graph));
  }

  if (issues.length > 0) {
    const shown = issues.slice(0, 12).join(', ');
    const more = issues.length > 12 ? ` (+${issues.length - 12} more)` : '';
    block(
      `[MPL Phase Contract Graph] decomposition.yaml is not a valid phase contract graph: ${shown}${more}. ` +
        `Add graph metadata, execution_tiers, per-phase evidence_required/change_policy/resource_locks, valid interface requires.from_phase refs, and (when state.release exists) preserve released-cut phase membership.`
    );
    return;
  }

  ok();
}

if (isMain) {
  await main().catch(() => ok());
}
