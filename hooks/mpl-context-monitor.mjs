#!/usr/bin/env node
/**
 * MPL Context Monitor Hook (#34 Stage 1, PostToolUse Task|Agent)
 *
 * Tracks cumulative token usage + tool_call count per phase for Runner chain.
 * Stage 1: measurement-only (writes to state, no baton-pass trigger).
 * Stage 2 (future): enforce baton-pass on threshold breach.
 *
 * Config (docs/config-schema.md):
 *   context_monitor.enabled         — master switch (default true)
 *   context_monitor.mode             — "measure" (Stage 1) | "enforce" (Stage 2)
 *   context_monitor.baton_threshold_pct  — 60 (phase boundary trigger)
 *   context_monitor.force_threshold_pct  — 80 (forced trigger)
 *   context_monitor.tool_call_warn       — 30 (warning)
 *
 * State written to .mpl/mpl/chains/{chain_id}/context-usage.json:
 *   {
 *     chain_id, runner_id, phase_id,
 *     cumulative_input_tokens, cumulative_output_tokens,
 *     tool_call_count,
 *     threshold_events: [{ type, at_percent, timestamp }]
 *   }
 *
 * Matcher: Task|Agent (only Phase Runner dispatches tracked; Seed/Test/Discovery
 * tracked separately by subagent_type).
 *
 * Non-blocking: always returns {continue: true}. Output suppressed on success.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

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

// Claude context window. Defaults to 1M (opus 4.6 extended context).
// Override via config.context_monitor.context_window_tokens (per-project)
// or CLAUDE_CONTEXT_TOKENS env var (session-wide).
const FALLBACK_CONTEXT_WINDOW = Number(process.env.CLAUDE_CONTEXT_TOKENS) || 1_000_000;

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function loadChainAssignment(cwd) {
  const p = join(cwd, '.mpl/mpl/chain-assignment.yaml');
  if (!existsSync(p)) return null;
  // Lightweight parse: we only need `chains[].id` and `phases[]` — let callers deal with YAML
  // For Stage 1 measure-only, we just record what we see; full parsing deferred to Stage 2.
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function chainIdForPhase(chainAssignmentYaml, phaseId) {
  if (!chainAssignmentYaml || !phaseId) return null;
  // Naive scan: look for a chain block whose `phases:` list contains phaseId
  const blocks = chainAssignmentYaml.split(/^\s*-\s+id:\s*/m).slice(1);
  for (const block of blocks) {
    const idMatch = block.match(/^["']?([^"'\n]+)["']?/);
    const phasesMatch = block.match(/phases:\s*\[([^\]]+)\]/);
    if (!idMatch || !phasesMatch) continue;
    const phases = phasesMatch[1].split(',').map(s => s.trim().replace(/["']/g, ''));
    if (phases.includes(phaseId)) return idMatch[1].trim();
  }
  return null;
}

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return ok(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const config = loadConfig(cwd) || {};
  const monitorCfg = config.context_monitor || {};
  if (monitorCfg.enabled === false) return ok();

  // Only track Task|Agent calls targeting Phase Runner (or others we care about)
  const toolName = data.tool_name || '';
  if (toolName !== 'Task' && toolName !== 'Agent') return ok();

  const toolInput = data.tool_input || {};
  const toolResponse = data.tool_response || {};
  const subagentType = toolInput.subagent_type || toolInput.subagentType || '';

  // Track the four #34 agent types
  const trackedAgents = new Set([
    'mpl-phase-runner', 'mpl:mpl-phase-runner',
    'mpl-seed-generator', 'mpl:mpl-seed-generator',
    'mpl-test-agent', 'mpl:mpl-test-agent',
    'mpl-discovery-agent', 'mpl:mpl-discovery-agent',
  ]);
  if (!trackedAgents.has(subagentType)) return ok();

  const usage = toolResponse.usage || {};
  const inputTokens = Number(
    (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  );
  const outputTokens = Number(usage.output_tokens || 0);
  // Dispatches = number of Task|Agent invocations of this subagent type.
  // (Claude Code PostToolUse tool_response does not expose internal tool-use count
  //  from within the subagent, so we track dispatches — which is the relevant
  //  signal for Runner chain session count anyway.)
  const dispatchesThis = 1;

  const state = readState(cwd) || {};
  const phaseId = state.current_phase_name || state.current_phase || 'unknown';

  // Resolve chain_id via chain-assignment.yaml
  const chainAssignment = loadChainAssignment(cwd);
  const chainId = chainIdForPhase(chainAssignment, phaseId) || 'no-chain';

  const agentTag = subagentType.split(':').pop();
  const chainDir = join(cwd, '.mpl/mpl/chains', chainId);
  ensureDir(chainDir);
  const usagePath = join(chainDir, 'context-usage.json');

  let record = {};
  if (existsSync(usagePath)) {
    try { record = JSON.parse(readFileSync(usagePath, 'utf-8')); } catch { record = {}; }
  }

  // Accumulate per-agent and overall
  record.chain_id = chainId;
  record.phase_id = phaseId;
  record.last_updated = new Date().toISOString();
  record.per_agent = record.per_agent || {};
  const perAgent = record.per_agent[agentTag] || {
    input_tokens: 0, output_tokens: 0, dispatches: 0,
  };
  perAgent.input_tokens += inputTokens;
  perAgent.output_tokens += outputTokens;
  perAgent.dispatches += dispatchesThis;
  record.per_agent[agentTag] = perAgent;

  record.cumulative_input_tokens = (record.cumulative_input_tokens || 0) + inputTokens;
  record.cumulative_output_tokens = (record.cumulative_output_tokens || 0) + outputTokens;
  record.total_dispatches = (record.total_dispatches || 0) + dispatchesThis;

  // Threshold detection (Stage 1 = measure only, no action)
  record.threshold_events = record.threshold_events || [];
  const contextWindow = Number(monitorCfg.context_window_tokens) || FALLBACK_CONTEXT_WINDOW;
  const pct = (record.cumulative_input_tokens / contextWindow) * 100;
  const warnThreshold = Number(monitorCfg.baton_threshold_pct || 60);
  const forceThreshold = Number(monitorCfg.force_threshold_pct || 80);
  const dispatchWarn = Number(monitorCfg.dispatch_warn || 30);

  const seenWarn = record.threshold_events.some(e => e.type === 'warn_60');
  const seenForce = record.threshold_events.some(e => e.type === 'force_80');
  const seenDispatchWarn = record.threshold_events.some(e => e.type === 'dispatch_warn');

  if (!seenWarn && pct >= warnThreshold) {
    record.threshold_events.push({
      type: 'warn_60', at_percent: pct.toFixed(1),
      timestamp: record.last_updated, mode: monitorCfg.mode || 'measure',
    });
  }
  if (!seenForce && pct >= forceThreshold) {
    record.threshold_events.push({
      type: 'force_80', at_percent: pct.toFixed(1),
      timestamp: record.last_updated, mode: monitorCfg.mode || 'measure',
    });
  }
  if (!seenDispatchWarn && record.total_dispatches >= dispatchWarn) {
    record.threshold_events.push({
      type: 'dispatch_warn', total_dispatches: record.total_dispatches,
      timestamp: record.last_updated, mode: monitorCfg.mode || 'measure',
    });
  }

  try {
    writeFileSync(usagePath, JSON.stringify(record, null, 2));
  } catch {
    // silent fail — measurement is best-effort, never block the pipeline
  }

  // Stage 1: measurement only, never triggers baton-pass
  // Stage 2 (future): if mode === 'enforce', write state flag for orchestrator
  return ok();
}

main().catch(() => ok());
