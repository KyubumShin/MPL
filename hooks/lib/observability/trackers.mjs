/**
 * MPL Trackers (L1 observability — Move #12)
 *
 * Absorbs the three tracker hooks:
 *   - mpl-context-monitor   -> handleContextMonitor
 *   - mpl-compaction-tracker -> handleCompactionTracker
 *   - mpl-tool-tracker       -> handleToolTracker
 *
 * Two of the three are pure measurement (tool-tracker, context-monitor) — they
 * return a "tracked" decision with a stateMutations patch and never veto.
 * compaction-tracker is the lone tracker with an embedded decision branch
 * (F-38 auto-rotation at compaction_count >= 3). To respect the L1↔L2
 * boundary the rotation pathway is exposed as an intent — the wrapper
 * applies the writeState + signal file. The legacy `.legacy.mjs` siblings
 * keep the byte-identical behavior for emergency rollback.
 *
 * Public API:
 *   - handle(name, ctx)
 *   - handleContextMonitor(ctx), handleCompactionTracker(ctx), handleToolTracker(ctx)
 *
 * Dependency boundary (per hooks/lib/observability/README.md):
 *   Imports L1 helpers + config + state-reader ONLY.
 *   NEVER imports any policy/* module or signals.mjs sub-handler.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';

// ---- envelope builders ---------------------------------------------------

function noop({ ruleId } = {}) {
  return { action: 'noop', ruleId: ruleId || null, stateMutations: null, fileWrites: null, suppressOutput: true };
}

function tracked({ ruleId, stateMutations = null, fileWrites = null, intents = null }) {
  return {
    action: 'tracked',
    ruleId: ruleId || null,
    stateMutations: stateMutations || null,
    fileWrites: fileWrites || null,
    intents: intents || null,
    suppressOutput: true,
  };
}

// ---- shared helpers ------------------------------------------------------

const TASK_TOOLS = new Set(['Task', 'Agent', 'task', 'agent']);
function isTaskTool(toolName) { return TASK_TOOLS.has(String(toolName || '')); }
function ensureDir(p) { try { if (!existsSync(p)) mkdirSync(p, { recursive: true }); } catch { /* noop */ } }

const FALLBACK_CONTEXT_WINDOW = Number(process.env.CLAUDE_CONTEXT_TOKENS) || 1_000_000;

// ============================================================================
// Context Monitor — Stage 1 measurement (#34)
// ============================================================================

const CONTEXT_TRACKED_AGENTS = new Set([
  'mpl-phase-runner', 'mpl:mpl-phase-runner',
  'mpl-seed-generator', 'mpl:mpl-seed-generator',
  'mpl-test-agent', 'mpl:mpl-test-agent',
  'mpl-discovery-agent', 'mpl:mpl-discovery-agent',
]);

function safeReadText(p) { try { return existsSync(p) ? readFileSync(p, 'utf-8') : null; } catch { return null; } }

export function chainIdForPhase(chainAssignmentYaml, phaseId) {
  if (!chainAssignmentYaml || !phaseId) return null;
  const blocks = chainAssignmentYaml.split(/^\s*-\s+id:\s*/m).slice(1);
  for (const block of blocks) {
    const idM = block.match(/^["']?([^"'\n]+)["']?/);
    const phM = block.match(/phases:\s*\[([^\]]+)\]/);
    if (!idM || !phM) continue;
    const phases = phM[1].split(',').map(s => s.trim().replace(/["']/g, ''));
    if (phases.includes(phaseId)) return idM[1].trim();
  }
  return null;
}

/**
 * Context Monitor — PostToolUse:Task|Agent. Returns a `tracked` decision with
 * a `fileWrites` entry the wrapper appends/writes verbatim.
 */
export function handleContextMonitor(ctx) {
  const { cwd, toolName, toolInput, toolResponse, state, config } = ctx;
  if (!isTaskTool(toolName)) return noop();

  const monitorCfg = (config && config.context_monitor) || {};
  if (monitorCfg.enabled === false) return noop();

  const subagentType = String((toolInput && (toolInput.subagent_type || toolInput.subagentType)) || '');
  if (!CONTEXT_TRACKED_AGENTS.has(subagentType)) return noop();

  const usage = (toolResponse && toolResponse.usage) || {};
  const inputTokens = Number((usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0));
  const outputTokens = Number(usage.output_tokens || 0);

  const phaseId = (state && (state.current_phase_name || state.current_phase)) || 'unknown';
  const chainAssignment = cwd ? safeReadText(join(cwd, '.mpl/mpl/chain-assignment.yaml')) : null;
  const chainId = chainIdForPhase(chainAssignment, phaseId) || 'no-chain';
  const agentTag = subagentType.split(':').pop();

  const usagePath = cwd ? join(cwd, '.mpl/mpl/chains', chainId, 'context-usage.json') : null;
  let record = {};
  if (usagePath && existsSync(usagePath)) {
    try { record = JSON.parse(readFileSync(usagePath, 'utf-8')); } catch { record = {}; }
  }

  record.chain_id = chainId;
  record.phase_id = phaseId;
  record.last_updated = new Date().toISOString();
  record.per_agent = record.per_agent || {};
  const per = record.per_agent[agentTag] || { input_tokens: 0, output_tokens: 0, dispatches: 0 };
  per.input_tokens += inputTokens; per.output_tokens += outputTokens; per.dispatches += 1;
  record.per_agent[agentTag] = per;

  record.cumulative_input_tokens = (record.cumulative_input_tokens || 0) + inputTokens;
  record.cumulative_output_tokens = (record.cumulative_output_tokens || 0) + outputTokens;
  record.total_dispatches = (record.total_dispatches || 0) + 1;

  record.threshold_events = record.threshold_events || [];
  const contextWindow = Number(monitorCfg.context_window_tokens) || FALLBACK_CONTEXT_WINDOW;
  const pct = (record.cumulative_input_tokens / contextWindow) * 100;
  const warnT = Number(monitorCfg.baton_threshold_pct || 60);
  const forceT = Number(monitorCfg.force_threshold_pct || 80);
  const dispatchWarn = Number(monitorCfg.dispatch_warn || 30);

  const has = (type) => record.threshold_events.some(e => e.type === type);
  const mode = monitorCfg.mode || 'measure';
  if (!has('warn_60') && pct >= warnT) {
    record.threshold_events.push({ type: 'warn_60', at_percent: pct.toFixed(1), timestamp: record.last_updated, mode });
  }
  if (!has('force_80') && pct >= forceT) {
    record.threshold_events.push({ type: 'force_80', at_percent: pct.toFixed(1), timestamp: record.last_updated, mode });
  }
  if (!has('dispatch_warn') && record.total_dispatches >= dispatchWarn) {
    record.threshold_events.push({ type: 'dispatch_warn', total_dispatches: record.total_dispatches, timestamp: record.last_updated, mode });
  }

  // Best-effort direct write so legacy callers still see the file even
  // when the wrapper does not replay fileWrites.
  if (cwd && usagePath) {
    try {
      ensureDir(dirname(usagePath));
      writeFileSync(usagePath, JSON.stringify(record, null, 2));
    } catch { /* silent */ }
  }

  return tracked({
    ruleId: 'tracker.context_monitor',
    fileWrites: usagePath ? [{ path: usagePath, content: JSON.stringify(record, null, 2), mode: 'overwrite' }] : null,
  });
}

// ============================================================================
// Compaction Tracker — PreCompact
// ============================================================================

/**
 * Compaction Tracker — PreCompact. Returns a `tracked` decision carrying
 *   - stateMutations: { compaction_count } increment (+ optional rotation patch)
 *   - fileWrites: [compactions.jsonl append, compaction-{N}.md, session-handoff.json]
 *   - intents:   [{ kind: 'runbook.append' }, optional { kind: 'rotate', reason }]
 *
 * The wrapper drives writeState + appendRunbookRow + budgetPredictor. The
 * handler stays L1-clean (no policy imports) and pure-data wherever possible.
 */
export function handleCompactionTracker(ctx) {
  const { cwd, state, raw, config } = ctx;
  if (!state) return noop();

  const trigger = (raw && raw.trigger) || 'unknown';
  const currentCount = Number(state.compaction_count || 0);
  const newCount = currentCount + 1;
  const ts = new Date().toISOString();

  const profileDir = cwd ? join(cwd, '.mpl/mpl/profile') : null;
  const checkpointsDir = cwd ? join(cwd, '.mpl/mpl/checkpoints') : null;
  const compactionsPath = profileDir ? join(profileDir, 'compactions.jsonl') : null;
  const checkpointPath = checkpointsDir ? join(checkpointsDir, `compaction-${newCount}.md`) : null;

  const record = {
    timestamp: ts,
    pipeline_id: state.pipeline_id || null,
    compaction_count: newCount,
    trigger,
    current_phase: state.current_phase || null,
    total_tokens_at_compaction: (state.cost && state.cost.total_tokens) || 0,
    fix_loop_count: state.fix_loop_count || 0,
  };

  const checkpointContent = [
    `# Compaction Checkpoint #${newCount}`,
    `- **Timestamp**: ${ts}`,
    `- **Current Phase**: ${record.current_phase}`,
    `- **Compaction Count**: ${newCount}`,
    `- **Context Usage**: triggered at compaction threshold`,
    ``,
    `## Recovery Instructions`,
    `Resume from current phase. Read state-summary.md from previous phases if context was lost.`,
  ].join('\n') + '\n';

  const fileWrites = [];
  if (compactionsPath) fileWrites.push({ path: compactionsPath, content: JSON.stringify(record) + '\n', mode: 'append' });
  if (checkpointPath) fileWrites.push({ path: checkpointPath, content: checkpointContent, mode: 'overwrite' });

  // Best-effort: also write directly so the trackers module is usable from
  // both the engine path (where the wrapper replays fileWrites) and a thin
  // wrapper that only consumes stateMutations.
  if (compactionsPath) {
    try { ensureDir(profileDir); appendFileSync(compactionsPath, JSON.stringify(record) + '\n'); } catch { /* silent */ }
  }
  if (checkpointPath) {
    try { ensureDir(checkpointsDir); writeFileSync(checkpointPath, checkpointContent); } catch { /* silent */ }
  }

  const stateMutations = { compaction_count: newCount };
  const intents = [{ kind: 'runbook.append', compaction_mark: `compaction-${newCount}`, started_at: state.started_at || null, ended_at: ts }];

  // F-38: rotation intent. We DO NOT call the budget predictor here (keeps
  // the handler pure); the wrapper consults predictBudget and applies the
  // rotation when intents includes { kind: 'rotate.maybe' }.
  if (newCount >= 3) {
    intents.push({
      kind: 'rotate.maybe',
      compaction_count: newCount,
      hard_limit: newCount >= 4,
      current_phase: state.current_phase || null,
      rotation_count: state.rotation_count || 0,
    });
  }

  return tracked({
    ruleId: 'tracker.compaction',
    stateMutations,
    fileWrites,
    intents,
  });
}

// ============================================================================
// Tool Tracker — G4 / #109 last_tool_at
// ============================================================================

/**
 * Tool Tracker — PostToolUse (all tools). The thinnest tracker; returns a
 * single state-patch intent. The wrapper drives writeState.
 */
export function handleToolTracker(/* ctx */) {
  return tracked({
    ruleId: 'tracker.tool_last_seen',
    stateMutations: { last_tool_at: new Date().toISOString() },
  });
}

// ============================================================================
// Top-level dispatch
// ============================================================================

const HANDLER_BY_NAME = {
  context_monitor: handleContextMonitor,
  compaction_tracker: handleCompactionTracker,
  tool_tracker: handleToolTracker,
};

export function handle(name, ctx) {
  const fn = HANDLER_BY_NAME[name];
  if (!fn) return noop({ ruleId: `trackers.unknown.${name}` });
  return fn(ctx || {});
}

export default {
  handle,
  handleContextMonitor, handleCompactionTracker, handleToolTracker,
  chainIdForPhase,
};
