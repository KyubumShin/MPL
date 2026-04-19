#!/usr/bin/env node
/**
 * MPL Require Test Agent Hook (PostToolUse on Task|Agent)
 *
 * Blocks the orchestrator from proceeding past a phase-runner completion if the
 * completed phase was marked `test_agent_required: true` in decomposition.yaml
 * and `state.test_agent_dispatched[phase_id]` is empty.
 *
 * Fixes the F-40 self-disabling pattern observed in ygg-exp11 (Opus 4.7):
 *   - 83 phase-runner dispatches, 1 test-agent dispatch (1.2% coverage)
 *   - The single test-agent dispatch found 5 gaps immediately
 *   - F-40's `pass_rate < 100%` trigger depended on phase-runner's self-test,
 *     which always reported 100%, so test-agent was never called
 *
 * AD-0007 enforcement contract:
 *   1. Decomposer emits `test_agent_required: true|false` + `test_agent_rationale`
 *      for every phase (boundary/e2e/db/algorithm/ai → true by default).
 *   2. This hook fires on phase-runner completion. It reads decomposition.yaml
 *      for the completed phase, and state.test_agent_dispatched for dispatch
 *      evidence (written by mpl-gate-recorder.mjs).
 *   3. If required AND not dispatched AND not overridden → emit block decision
 *      so the orchestrator must dispatch test-agent before continuing.
 *   4. Override: `.mpl/config/test-agent-override.json` with explicit phase-id +
 *      user-supplied reason. Blanket overrides ("all-phases": "trivial") are
 *      logged as anti-patterns but accepted (user has final say).
 *
 * Non-blocking on error: swallows every exception and returns {continue: true}
 * to avoid wedging the pipeline on hook bugs.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(JSON.stringify({ continue: true, decision: 'block', reason }));
}

/**
 * Extract phase id from the phase-runner prompt. Looks for "phase-N" / "phase N".
 * Returns null if no match — the hook conservatively allows such dispatches (the
 * orchestrator may be running a non-phase task through the runner).
 */
function extractPhaseId(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bphase[-\s]?(\d+)\b/i);
  return m ? `phase-${m[1]}` : null;
}

/**
 * Parse decomposition.yaml (minimal YAML subset — we only need per-phase keys).
 * Returns { phases: [{ id, test_agent_required, test_agent_rationale }, ...] }.
 * Uses naive line-based parsing to avoid pulling in a YAML dep; MPL project
 * policy forbids third-party runtime deps (see harness_lab CLAUDE.md).
 */
function parseDecomposition(cwd) {
  const decompPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(decompPath)) return null;

  const text = readFileSync(decompPath, 'utf-8');
  const phases = [];
  let cur = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    // Phase entry start: "  - id: phase-3"  (2-space indent) or "- id: phase-3"
    const idMatch = line.match(/^\s*-\s+id:\s*["']?(phase-[\w-]+)["']?/);
    if (idMatch) {
      if (cur) phases.push(cur);
      cur = { id: idMatch[1], test_agent_required: null, test_agent_rationale: null };
      continue;
    }

    if (!cur) continue;

    const reqMatch = line.match(/^\s+test_agent_required:\s*(true|false)\s*$/i);
    if (reqMatch) {
      cur.test_agent_required = reqMatch[1].toLowerCase() === 'true';
      continue;
    }

    const ratMatch = line.match(/^\s+test_agent_rationale:\s*["']?(.+?)["']?\s*$/);
    if (ratMatch) {
      cur.test_agent_rationale = ratMatch[1];
      continue;
    }
  }
  if (cur) phases.push(cur);

  return { phases };
}

/**
 * Load user-supplied override config.
 * Schema: { "phase-3": "trivial doc edit", "phase-5": "manual qa done" }
 * Or blanket: { "*": "global bypass — use with caution" }
 */
function loadOverride(cwd) {
  const overridePath = join(cwd, '.mpl', 'config', 'test-agent-override.json');
  if (!existsSync(overridePath)) return {};
  try {
    return JSON.parse(readFileSync(overridePath, 'utf-8'));
  } catch {
    return {};
  }
}

try {
  const raw = await readStdin();
  if (!raw.trim()) {
    ok();
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    ok();
    process.exit(0);
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    ok();
    process.exit(0);
  }

  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Task', 'task', 'Agent', 'agent'].includes(toolName)) {
    ok();
    process.exit(0);
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const agentType = String(toolInput.subagent_type || toolInput.subagentType || '');

  // We only care about phase-runner completions. Every other agent type (test-agent
  // itself, git-master, decomposer, etc.) passes through.
  if (!/mpl-phase-runner$/.test(agentType)) {
    ok();
    process.exit(0);
  }

  const phaseId = extractPhaseId(toolInput.prompt || toolInput.description || '');
  if (!phaseId) {
    // Non-phase task — conservatively allow.
    ok();
    process.exit(0);
  }

  const decomp = parseDecomposition(cwd);
  if (!decomp) {
    // Decomposition not yet available (pre-phase-2 or external dispatch) — allow.
    ok();
    process.exit(0);
  }

  const phase = decomp.phases.find((p) => p.id === phaseId);
  if (!phase) {
    // Phase not in decomposition — conservatively allow.
    ok();
    process.exit(0);
  }

  // Default safety: if the field is missing, TREAT AS REQUIRED. AD-0007 intent is
  // that Decomposer must actively mark `test_agent_required: false` with a
  // rationale to opt out; absence is not permission.
  const required = phase.test_agent_required !== false;
  if (!required) {
    ok();
    process.exit(0);
  }

  // Check override
  const override = loadOverride(cwd);
  if (override[phaseId] || override['*']) {
    // Override accepted — the reason is logged but we do not block.
    ok();
    process.exit(0);
  }

  // Check dispatch record
  const state = readState(cwd) || {};
  const dispatched = state.test_agent_dispatched || {};
  if (dispatched[phaseId]) {
    ok();
    process.exit(0);
  }

  // Not overridden, required, not dispatched → BLOCK
  const rationale = phase.test_agent_rationale
    ? ` (rationale: ${phase.test_agent_rationale})`
    : '';
  block(
    `[MPL AD-0007] Phase ${phaseId} is marked test_agent_required=true${rationale} ` +
      `but mpl-test-agent was not dispatched. You MUST run Task(subagent_type="mpl-test-agent", ` +
      `model="sonnet", prompt=...) with the phase's interface_contract + impact files ` +
      `BEFORE proceeding to the next phase. code_author == test_author is a tautology, ` +
      `not a verification (AD-0004). To bypass with user consent, add ${phaseId} to ` +
      `.mpl/config/test-agent-override.json with a reason.`
  );
} catch {
  // Hook must never wedge the pipeline.
  ok();
}
