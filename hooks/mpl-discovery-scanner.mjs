#!/usr/bin/env node
/**
 * MPL Discovery Scanner Hook (#34 Stage 1, PostToolUse Task|Agent)
 *
 * Reads `.mpl/mpl/chains/{chain_id}/phases/{phase_id}/discovery-candidates.yaml`
 * written by Phase Runner, and filters it mechanically against:
 *   1. Phase 0 design-intent.yaml (known rationale/blocks_on/non_goals)
 *   2. chain-seed.yaml for this chain (known contracts/files)
 *   3. decomposition.yaml (known phase impact files)
 *
 * Emits `.mpl/mpl/chains/{chain_id}/phases/{phase_id}/discovery-pending.yaml`
 * containing only candidates that passed mechanical filtering.
 *
 * Stage 1: filter runs in measure-only mode — pending list is written, but
 * Discovery Agent is NOT dispatched (discovery.agent_enabled = false by default).
 * Stage 2: enabling discovery.agent_enabled triggers orchestrator dispatch.
 *
 * Non-blocking: always returns {continue: true}.
 * Never throws — failure just skips this scan cycle.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function safeRead(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch { return null; }
}

function readCandidates(path) {
  const content = safeRead(path);
  if (!content) return [];
  // Lightweight parse: extract items under `candidates:` block
  // Format:  - id: "...", type: "...", path/contract/file/...
  const candidates = [];
  const lines = content.split('\n');
  let inList = false;
  let current = null;
  for (const line of lines) {
    if (/^candidates:\s*$/.test(line)) { inList = true; continue; }
    if (!inList) continue;
    const itemStart = line.match(/^\s*-\s*id:\s*["']?([^"'\n]+)["']?/);
    if (itemStart) {
      if (current) candidates.push(current);
      current = { id: itemStart[1].trim(), raw: [line] };
      continue;
    }
    if (current && /^\s{4,}/.test(line)) {
      current.raw.push(line);
      const kv = line.match(/^\s+(\w+):\s*["']?([^"'\n]*)["']?/);
      if (kv) current[kv[1]] = kv[2].trim();
    } else if (current && /^\s*$/.test(line)) {
      continue;
    } else if (current && !line.startsWith(' ')) {
      candidates.push(current);
      current = null;
      inList = false;
    }
  }
  if (current) candidates.push(current);
  return candidates;
}

function phase0Contains(designIntentYaml, needle) {
  if (!designIntentYaml || !needle) return false;
  return designIntentYaml.includes(needle);
}

function chainSeedContains(chainSeedYaml, needle) {
  if (!chainSeedYaml || !needle) return false;
  return chainSeedYaml.includes(needle);
}

function decompositionContains(decompositionYaml, needle) {
  if (!decompositionYaml || !needle) return false;
  return decompositionYaml.includes(needle);
}

function shouldFilter(candidate, designIntent, chainSeed, decomposition) {
  // Return true to FILTER OUT (candidate is noise, not real discovery).
  // Return false to KEEP (candidate warrants Discovery Agent review).
  const needle = candidate.path || candidate.file || candidate.contract || candidate.symbol;
  if (!needle) return false; // no discriminator → keep for safety

  // Noise patterns:
  // 1. If the thing is already declared in any known doc → noise.
  if (phase0Contains(designIntent, needle)) return true;
  if (chainSeedContains(chainSeed, needle)) return true;
  if (decompositionContains(decomposition, needle)) return true;

  // 2. Variable rename heuristic (candidate.type === "rename") → treat as noise unless also crosses boundary
  if (candidate.type === 'rename' || candidate.type === 'variable_rename') return true;

  // 3. Test-only changes in test files are not architectural
  if (candidate.type === 'test_fixture' || candidate.type === 'test_data') return true;

  // Keep everything else.
  return false;
}

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return ok(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const config = loadConfig(cwd) || {};
  const discoveryCfg = config.discovery || {};
  if (discoveryCfg.scanner_enabled === false) return ok();

  const toolName = data.tool_name || '';
  if (toolName !== 'Task' && toolName !== 'Agent') return ok();

  const toolInput = data.tool_input || {};
  const subagentType = toolInput.subagent_type || toolInput.subagentType || '';
  const runnerAgents = new Set(['mpl-phase-runner', 'mpl:mpl-phase-runner']);
  if (!runnerAgents.has(subagentType)) return ok();

  const state = readState(cwd) || {};
  const phaseId = state.current_phase_name || state.current_phase || 'unknown';

  // Locate chain directory for this phase
  const chainAssignmentPath = join(cwd, '.mpl/mpl/chain-assignment.yaml');
  const chainAssignment = safeRead(chainAssignmentPath);
  if (!chainAssignment) return ok(); // no chain structure yet

  const blocks = chainAssignment.split(/^\s*-\s+id:\s*/m).slice(1);
  let chainId = null;
  for (const block of blocks) {
    const idMatch = block.match(/^["']?([^"'\n]+)["']?/);
    const phasesMatch = block.match(/phases:\s*\[([^\]]+)\]/);
    if (!idMatch || !phasesMatch) continue;
    const phases = phasesMatch[1].split(',').map(s => s.trim().replace(/["']/g, ''));
    if (phases.includes(phaseId)) { chainId = idMatch[1].trim(); break; }
  }
  if (!chainId) return ok();

  const candidatesPath = join(cwd, '.mpl/mpl/chains', chainId, 'phases', phaseId, 'discovery-candidates.yaml');
  if (!existsSync(candidatesPath)) return ok();

  const candidates = readCandidates(candidatesPath);
  if (candidates.length === 0) return ok();

  const designIntent = safeRead(join(cwd, '.mpl/mpl/phase0/design-intent.yaml'));
  const chainSeed = safeRead(join(cwd, '.mpl/mpl/chains', chainId, 'chain-seed.yaml'));
  const decomposition = safeRead(join(cwd, '.mpl/mpl/decomposition.yaml'));

  const pending = [];
  const filtered = [];
  for (const c of candidates) {
    if (shouldFilter(c, designIntent, chainSeed, decomposition)) {
      filtered.push({ id: c.id, reason: 'mechanical_filter_matched', type: c.type || 'unknown' });
    } else {
      pending.push(c);
    }
  }

  const pendingPath = join(cwd, '.mpl/mpl/chains', chainId, 'phases', phaseId, 'discovery-pending.yaml');
  const filteredPath = join(cwd, '.mpl/mpl/chains', chainId, 'phases', phaseId, 'discovery-filtered.yaml');

  const pendingYaml = [
    `# Discovery Scanner output — candidates that passed mechanical filter`,
    `chain_id: "${chainId}"`,
    `phase_id: "${phaseId}"`,
    `scanned_at: "${new Date().toISOString()}"`,
    `scanner_mode: "${discoveryCfg.agent_enabled ? 'agent_enabled' : 'measure_only'}"`,
    `pending_count: ${pending.length}`,
    `filtered_count: ${filtered.length}`,
    `candidates:`,
    ...pending.flatMap(c => c.raw || [`  - id: "${c.id}"`]),
  ].join('\n');

  const filteredYaml = [
    `# Discovery Scanner — candidates filtered out as noise`,
    `chain_id: "${chainId}"`,
    `phase_id: "${phaseId}"`,
    `scanned_at: "${new Date().toISOString()}"`,
    `filtered:`,
    ...filtered.map(f => `  - id: "${f.id}"\n    reason: "${f.reason}"\n    type: "${f.type}"`),
  ].join('\n');

  try {
    writeFileSync(pendingPath, pendingYaml);
    writeFileSync(filteredPath, filteredYaml);
  } catch {
    // silent
  }

  // Stage 1: scanner runs but does not trigger Discovery Agent.
  // Stage 2: orchestrator watches pendingPath and dispatches Discovery Agent
  //          when discoveryCfg.agent_enabled === true && pending_count > 0.
  return ok();
}

main().catch(() => ok());
