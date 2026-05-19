#!/usr/bin/env node
/**
 * MPL Require Phase Contract Graph Hook (PreToolUse on Write|Edit|MultiEdit).
 *
 * Blocks decomposition writes when the file is only a task list instead of a
 * contract graph: missing graph metadata, missing phase evidence/change policy,
 * or dangling phase dependencies.
 */

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
  }

  if (issues.length > 0) {
    const shown = issues.slice(0, 12).join(', ');
    const more = issues.length > 12 ? ` (+${issues.length - 12} more)` : '';
    block(
      `[MPL Phase Contract Graph] decomposition.yaml is not a valid phase contract graph: ${shown}${more}. ` +
        `Add graph metadata, execution_tiers, per-phase evidence_required/change_policy/resource_locks, and valid interface requires.from_phase refs.`
    );
    return;
  }

  ok();
}

if (isMain) {
  await main().catch(() => ok());
}
