#!/usr/bin/env node
/**
 * MPL HUD (Heads-Up Display)
 * Statusline renderer for Claude Code — shows MPL pipeline state at a glance.
 *
 * Configured via Claude Code's statusLine mechanism:
 *   ~/.claude/settings.json → "statusLine": { "type": "command", "command": "node <path>/mpl-hud.mjs" }
 *
 * Claude Code calls this command periodically (~500ms) with JSON on stdin.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ── ANSI Colors ──────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

// ── Stdin Reader ─────────────────────────────────────────────────────────────

async function readStdin(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; process.stdin.removeAllListeners(); resolve(Buffer.concat(chunks).toString('utf-8')); }
    }, timeoutMs);
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } });
    process.stdin.on('error', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(''); } });
    if (process.stdin.readableEnded) { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } }
  });
}

// ── State Readers ────────────────────────────────────────────────────────────

function readMplState(cwd) {
  try {
    const statePath = join(cwd, '.mpl', 'state.json');
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (typeof parsed !== 'object' || !parsed.current_phase) return null;
    return parsed;
  } catch { return null; }
}

function getProjectFolder(cwd) {
  return cwd.split('/').pop();
}

function getSessionUsage(state) {
  if (!state) return 0;
  return state.cost?.total_tokens || 0;
}

function getWeeklyUsage(cwd) {
  try {
    const usagePath = join(cwd, '.mpl', 'usage', 'weekly.jsonl');
    if (!existsSync(usagePath)) return 0;
    const lines = readFileSync(usagePath, 'utf-8').split('\n').filter(l => l.trim());
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let total = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (new Date(entry.timestamp).getTime() >= oneWeekAgo) {
          total += entry.tokens || 0;
        }
      } catch { /* skip malformed */ }
    }
    return total;
  } catch { return 0; }
}

// ── Formatters ───────────────────────────────────────────────────────────────

function formatDuration(startedAt) {
  if (!startedAt) return null;
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h${mins % 60}m`;
  return `${mins}m`;
}

function formatTier(tier) {
  if (!tier) return `${c.gray}--${c.reset}`;
  const map = {
    frugal: `${c.green}Frugal${c.reset}`,
    standard: `${c.yellow}Standard${c.reset}`,
    frontier: `${c.magenta}Frontier${c.reset}`,
  };
  return map[tier] || tier;
}

function formatPhase(phase) {
  if (!phase) return '--';
  const map = {
    'phase1a-research': 'P0:Research',
    'phase1b-plan': 'P0:Plan',
    'phase2-sprint': 'Sprint',
    'phase3-gate': 'Gate',
    'phase4-fix': 'Fix',
    'phase5-finalize': 'Finalize',
    'small-plan': 'Plan',
    'small-execute': 'Execute',
    'small-gate': 'Gate',
    'completed': 'Done',
    'cancelled': 'Cancelled',
  };
  return map[phase] || phase;
}

function formatGate(gate1, gate2, gate3) {
  const g = (val) => {
    if (val === true) return `${c.green}✓${c.reset}`;
    if (val === false) return `${c.red}✗${c.reset}`;
    return `${c.gray}-${c.reset}`;
  };
  return `${g(gate1)}${g(gate2)}${g(gate3)}`;
}

function formatContext(contextPercent) {
  if (contextPercent == null) return null;
  const pct = Math.round(contextPercent);
  if (pct >= 85) return `${c.red}${c.bold}${pct}%${c.reset}`;
  if (pct >= 70) return `${c.yellow}${pct}%${c.reset}`;
  return `${c.green}${pct}%${c.reset}`;
}

function formatFixLoop(count, max) {
  if (count == null) return null;
  const ratio = count / (max || 10);
  if (ratio >= 0.8) return `${c.red}${c.bold}${count}/${max}${c.reset}`;
  if (ratio >= 0.5) return `${c.yellow}${count}/${max}${c.reset}`;
  return `${c.dim}${count}/${max}${c.reset}`;
}

function formatTokens(used, max) {
  if (!max) return null;
  const k = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
  const ratio = used / max;
  const color = ratio >= 0.8 ? c.red : ratio >= 0.5 ? c.yellow : c.dim;
  return `${color}${k(used)}/${k(max)}${c.reset}`;
}

function formatSessionUsage(tokens) {
  const str = tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M`
    : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K`
    : `${tokens}`;
  // session: green < 100K, yellow 100K-300K, red > 300K
  const color = tokens >= 300000 ? c.red : tokens >= 100000 ? c.yellow : c.green;
  return `${color}${str}${c.reset}`;
}

function formatWeeklyUsage(tokens) {
  const str = tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M`
    : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K`
    : `${tokens}`;
  // weekly: green < 500K, yellow 500K-2M, red > 2M
  const color = tokens >= 2000000 ? c.red : tokens >= 500000 ? c.yellow : c.green;
  return `${color}${str}${c.reset}`;
}

function formatTodos(sprint) {
  if (!sprint || sprint.total_todos === 0) return null;
  const { completed_todos: done, total_todos: total, failed_todos: fail } = sprint;
  let s = `${done}/${total}`;
  if (fail > 0) s += `${c.red}(${fail}✗)${c.reset}`;
  return s;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let stdin = {};
  try {
    const raw = await readStdin(1000);
    if (raw) stdin = JSON.parse(raw);
  } catch { /* no stdin or invalid JSON */ }

  const cwd = stdin.cwd || process.cwd();
  const state = readMplState(cwd);
  const folder = getProjectFolder(cwd);

  // Debug: log stdin keys to find context_window structure
  const stdinKeys = Object.keys(stdin).join(',');

  // Context percent from Claude Code stdin
  // Try multiple possible field structures
  let contextPercent = null;
  if (stdin.context_window && stdin.context_window.total > 0) {
    contextPercent = (stdin.context_window.used / stdin.context_window.total) * 100;
  } else if (stdin.contextWindow && stdin.contextWindow.total > 0) {
    contextPercent = (stdin.contextWindow.used / stdin.contextWindow.total) * 100;
  } else if (typeof stdin.context_percent === 'number') {
    contextPercent = stdin.context_percent;
  }

  // Usage tracking
  const sessionTokens = getSessionUsage(state);
  const weeklyTokens = getWeeklyUsage(cwd);

  // ── Line 1: Project info ──────────────────────────────────────────────────

  const parts1 = [];
  parts1.push(`${c.bold}${c.white}${folder}${c.reset}`);
  parts1.push(`${c.blue}session:${c.reset}${formatSessionUsage(sessionTokens)}`);
  parts1.push(`${c.magenta}week:${c.reset}${formatWeeklyUsage(weeklyTokens)}`);
  if (contextPercent != null) {
    parts1.push(`${c.cyan}ctx:${c.reset}${formatContext(contextPercent)}`);
  } else {
    // Debug: show stdin keys to diagnose missing context_window
    parts1.push(`${c.gray}ctx:[${stdinKeys}]${c.reset}`);
  }

  const duration = state ? formatDuration(state.started_at) : null;
  if (duration) parts1.push(`${c.gray}${duration}${c.reset}`);

  // ── Line 2: MPL pipeline status (only when MPL active) ────────────────────

  if (state && state.current_phase !== 'completed' && state.current_phase !== 'cancelled') {
    const parts2 = [];

    // Tier + Phase
    parts2.push(`${c.bold}MPL${c.reset} ${formatTier(state.pipeline_tier)}`);
    parts2.push(formatPhase(state.current_phase));

    // TODOs
    const todos = formatTodos(state.sprint_status);
    if (todos) parts2.push(`${c.cyan}TODO:${c.reset}${todos}`);

    // Gates
    const gr = state.gate_results;
    if (gr && (gr.gate1_passed != null || gr.gate2_passed != null || gr.gate3_passed != null)) {
      parts2.push(`${c.blue}Gate:${c.reset}${formatGate(gr.gate1_passed, gr.gate2_passed, gr.gate3_passed)}`);
    }

    // Fix loop
    if (state.fix_loop_count > 0) {
      parts2.push(`${c.yellow}Fix:${c.reset}${formatFixLoop(state.fix_loop_count, state.max_fix_loops)}`);
    }

    // Tokens
    const tokens = formatTokens(state.cost?.total_tokens || 0, state.cost?.max_total_tokens);
    if (tokens) parts2.push(`${c.magenta}tok:${c.reset}${tokens}`);

    // Tool mode (compact)
    if (state.tool_mode && state.tool_mode !== 'full') {
      parts2.push(`${c.gray}[${state.tool_mode}]${c.reset}`);
    }

    console.log(parts1.join(' | '));
    console.log(parts2.join(' | '));
  } else if (state && (state.current_phase === 'completed' || state.current_phase === 'cancelled')) {
    // Completed/cancelled — show minimal
    const status = state.current_phase === 'completed'
      ? `${c.green}${c.bold}✓ Complete${c.reset}`
      : `${c.yellow}Cancelled${c.reset}`;
    console.log(parts1.join(' | '));
    console.log(`${c.bold}MPL${c.reset} ${status} | ${formatTier(state.pipeline_tier)}`);
  } else {
    // No MPL state — show basic info only
    console.log(parts1.join(' | '));
  }
}

main().catch(() => {
  // Silent fail — HUD should never crash Claude Code
  console.log('MPL');
});
