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

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';

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

// ── OAuth Usage API ─────────────────────────────────────────────────────────

const CACHE_TTL_SUCCESS = 300_000; // 5 minutes — usage data doesn't change fast
const CACHE_TTL_FAILURE = 60_000;  // 1 minute retry on failure
const API_TIMEOUT = 3_000;

// File-based cache so it persists across HUD invocations
function getUsageCachePath() {
  return join(homedir(), '.claude', '.mpl-usage-cache.json');
}

function readUsageCache() {
  try {
    const p = getUsageCachePath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function writeUsageCache(cache) {
  try { writeFileSync(getUsageCachePath(), JSON.stringify(cache)); } catch { /* best-effort */ }
}

function getOAuthToken() {
  // Try macOS Keychain first
  if (process.platform === 'darwin') {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { timeout: 1500, stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString().trim();
      const parsed = JSON.parse(raw);
      const creds = parsed.claudeAiOauth || parsed;
      if (creds.accessToken) return creds.accessToken;
    } catch { /* fall through */ }
  }

  // Fallback: credentials file
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credPath)) return null;
    const parsed = JSON.parse(readFileSync(credPath, 'utf-8'));
    const creds = parsed.claudeAiOauth || parsed;
    return creds.accessToken || null;
  } catch { return null; }
}

function fetchUsage() {
  // Return cached data if fresh enough
  const cache = readUsageCache();
  const now = Date.now();

  if (cache) {
    const ttl = cache.error ? CACHE_TTL_FAILURE : CACHE_TTL_SUCCESS;
    if (now - cache.timestamp < ttl) {
      return cache.data;
    }
  }

  // Cache expired or missing — do synchronous refresh (curl with tight timeout)
  // Must be synchronous because Node.js process exits after stdout, killing async fetches
  const token = getOAuthToken();
  if (!token) {
    writeUsageCache({ timestamp: now, data: null, error: true });
    return cache?.data || null;
  }

  try {
    const result = execSync(
      `curl -s -w '\\n%{http_code}' --max-time 2 -H "Authorization: Bearer ${token}" -H "anthropic-beta: oauth-2025-04-20" -H "Content-Type: application/json" https://api.anthropic.com/api/oauth/usage`,
      { timeout: 2500, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();

    // Parse response: body + HTTP status code on last line
    const lines = result.split('\n');
    const httpCode = parseInt(lines.pop(), 10);
    const bodyStr = lines.join('\n');
    const body = JSON.parse(bodyStr);

    if (httpCode !== 200 || body.error) {
      throw new Error(`API ${httpCode}`);
    }

    const data = {
      fiveHour: body.five_hour?.utilization ?? null,
      fiveHourResetsAt: body.five_hour?.resets_at || null,
      weekly: body.seven_day?.utilization ?? null,
      weeklyResetsAt: body.seven_day?.resets_at || null,
    };
    writeUsageCache({ timestamp: now, data, error: false });
    return data;
  } catch {
    // API call failed — cache the failure, return stale data
    writeUsageCache({ timestamp: now, data: null, error: true });
    return cache?.data || null;
  }
}

function formatTimeUntil(isoDate) {
  if (!isoDate) return '';
  const ms = new Date(isoDate).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${mins % 60}m`;
  return `${mins}m`;
}

function formatRateLimit(percent, resetsAt, label) {
  if (percent == null) return null;
  const pct = Math.round(percent);
  const color = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
  const reset = resetsAt ? `${c.gray}(${formatTimeUntil(resetsAt)})${c.reset}` : '';
  return `${color}${pct}%${c.reset}${reset}`;
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

function formatGate(hard1, hard2, hard3) {
  const g = (val) => {
    if (val === true) return `${c.green}✓${c.reset}`;
    if (val === false) return `${c.red}✗${c.reset}`;
    return `${c.gray}-${c.reset}`;
  };
  return `${g(hard1)}${g(hard2)}${g(hard3)}`;
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

function formatTokens(used) {
  if (!used || used <= 0) return null;
  const k = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
  return `${c.dim}${k(used)}${c.reset}`;
}

function formatTodos(sprint) {
  if (!sprint || sprint.total_todos === 0) return null;
  const { completed_todos: done, total_todos: total, failed_todos: fail } = sprint;
  let s = `${done}/${total}`;
  if (fail > 0) s += `${c.red}(${fail}✗)${c.reset}`;
  return s;
}

// ── Fixed-width output ──────────────────────────────────────────────────────

const HUD_WIDTH = 90;

/** Strip ANSI escape codes to get visible character length. */
function visibleLength(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Pad line with spaces to fixed width. */
function padLine(str) {
  const vLen = visibleLength(str);
  if (vLen >= HUD_WIDTH) return str;
  return str + ' '.repeat(HUD_WIDTH - vLen);
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

  // Context percent from Claude Code stdin
  let contextPercent = null;
  const cw = stdin.context_window;
  if (cw) {
    if (typeof cw.used_percentage === 'number' && !Number.isNaN(cw.used_percentage)) {
      contextPercent = Math.min(100, Math.max(0, Math.round(cw.used_percentage)));
    } else if (cw.context_window_size > 0 && cw.current_usage) {
      const totalTokens = (cw.current_usage.input_tokens || 0)
        + (cw.current_usage.cache_creation_input_tokens || 0)
        + (cw.current_usage.cache_read_input_tokens || 0);
      contextPercent = Math.min(100, Math.round((totalTokens / cw.context_window_size) * 100));
    }
  }

  // F-33: Write context usage to file for budget predictor
  if (contextPercent != null && cwd) {
    try {
      const mplDir = join(cwd, '.mpl');
      if (existsSync(mplDir)) {
        const usageData = {
          pct: contextPercent,
          total_tokens: cw?.context_window_size || 0,
          used_tokens: cw?.current_usage
            ? (cw.current_usage.input_tokens || 0)
              + (cw.current_usage.cache_creation_input_tokens || 0)
              + (cw.current_usage.cache_read_input_tokens || 0)
            : 0,
          timestamp: Date.now(),
        };
        writeFileSync(join(mplDir, 'context-usage.json'), JSON.stringify(usageData));
      }
    } catch { /* non-blocking — HUD must never slow down */ }
  }

  // OAuth usage from Anthropic API
  const usage = await fetchUsage();

  // ── Line 1: Project info ──────────────────────────────────────────────────

  const parts1 = [];
  parts1.push(`${c.bold}${c.white}${folder}${c.reset}`);

  // Rate limits from OAuth API
  if (usage) {
    const fh = formatRateLimit(usage.fiveHour, usage.fiveHourResetsAt);
    const wk = formatRateLimit(usage.weekly, usage.weeklyResetsAt);
    if (fh) parts1.push(`${c.blue}5h:${c.reset}${fh}`);
    if (wk) parts1.push(`${c.magenta}wk:${c.reset}${wk}`);
  } else {
    parts1.push(`${c.gray}usage:--${c.reset}`);
  }

  if (contextPercent != null) {
    parts1.push(`${c.cyan}ctx:${c.reset}${formatContext(contextPercent)}`);
  }

  const duration = state ? formatDuration(state.started_at) : null;
  if (duration) parts1.push(`${c.gray}${duration}${c.reset}`);

  // ── Line 2: MPL pipeline status (only when MPL active) ────────────────────

  if (state && state.current_phase !== 'completed' && state.current_phase !== 'cancelled') {
    const parts2 = [];

    // Phase label (v0.17 #55: pp_proximity display removed — no longer tracked)
    parts2.push(`${c.bold}MPL${c.reset}`);
    parts2.push(formatPhase(state.current_phase));

    // TODOs
    const todos = formatTodos(state.sprint_status);
    if (todos) parts2.push(`${c.cyan}TODO:${c.reset}${todos}`);

    // Gates (Hard gates)
    const gr = state.gate_results;
    if (gr && (gr.hard1_passed != null || gr.hard2_passed != null || gr.hard3_passed != null)) {
      parts2.push(`${c.blue}Gate:${c.reset}${formatGate(gr.hard1_passed, gr.hard2_passed, gr.hard3_passed)}`);
    }

    // Fix loop
    if (state.fix_loop_count > 0) {
      parts2.push(`${c.yellow}Fix:${c.reset}${formatFixLoop(state.fix_loop_count, state.max_fix_loops)}`);
    }

    // Tokens
    const tokens = formatTokens(state.cost?.total_tokens || 0);
    if (tokens) parts2.push(`${c.magenta}tok:${c.reset}${tokens}`);

    // Tool mode (compact)
    if (state.tool_mode && state.tool_mode !== 'full') {
      parts2.push(`${c.gray}[${state.tool_mode}]${c.reset}`);
    }

    console.log(padLine(parts1.join(' | ')));
    console.log(padLine(parts2.join(' | ')));
  } else if (state && (state.current_phase === 'completed' || state.current_phase === 'cancelled')) {
    // Completed/cancelled — show minimal
    const status = state.current_phase === 'completed'
      ? `${c.green}${c.bold}✓ Complete${c.reset}`
      : `${c.yellow}Cancelled${c.reset}`;
    console.log(padLine(parts1.join(' | ')));
    console.log(padLine(`${c.bold}MPL${c.reset} ${status}`));
  } else {
    // No MPL state — show basic info only
    console.log(padLine(parts1.join(' | ')));
  }
}

main().catch(() => {
  // Silent fail — HUD should never crash Claude Code
  console.log('MPL');
});
