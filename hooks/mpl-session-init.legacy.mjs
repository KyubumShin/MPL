#!/usr/bin/env node
/**
 * MPL Session Init Hook (F-38)
 * Fires on SessionStart. Detects if this is a post-rotation restart
 * and injects resume context.
 *
 * Detection: .mpl/signals/session-handoff.json exists + is recent (<120s)
 */
import { existsSync, readFileSync, unlinkSync, statSync, writeFileSync, openSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const HANDOFF_MAX_AGE_MS = 120000; // 120s - handoff signal must be recent
const BUILD_LOCK_MAX_AGE_MS = 300000; // 5min - stale lock cleanup
const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..'); // hooks/ -> plugin root

/**
 * Ensure mcp-server is built. On first plugin install the cache contains
 * only src/, so dist/ and node_modules/ are missing and mpl-server cannot
 * start. This spawns a detached build once, writes a lock to prevent
 * re-entry, and returns a one-time notice for the session.
 *
 * Returns a notice string when a build was kicked off, null otherwise.
 */
function ensureMcpServerBuilt() {
  const mcpDir = join(PLUGIN_ROOT, 'mcp-server');
  if (!existsSync(join(mcpDir, 'package.json'))) return null; // no mcp-server in this plugin

  const distPath = join(mcpDir, 'dist', 'index.js');
  const depsPath = join(mcpDir, 'node_modules', '@modelcontextprotocol');
  if (existsSync(distPath) && existsSync(depsPath)) return null; // already built

  const lockPath = join(mcpDir, '.build-lock');
  if (existsSync(lockPath)) {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age < BUILD_LOCK_MAX_AGE_MS) {
        // Build still in progress — stay quiet, user already saw the first notice.
        return null;
      }
      unlinkSync(lockPath);
    } catch { /* ignore */ }
  }

  try {
    writeFileSync(lockPath, String(Date.now()));
  } catch {
    return null; // cannot write lock — give up silently
  }

  const logPath = join(mcpDir, '.build.log');
  let outFd, errFd;
  try {
    outFd = openSync(logPath, 'a');
    errFd = openSync(logPath, 'a');
  } catch {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    return null;
  }

  try {
    const child = spawn(
      'sh',
      ['-c', `npm install && npm run build; rm -f "${lockPath}"`],
      { cwd: mcpDir, detached: true, stdio: ['ignore', outFd, errFd] }
    );
    child.unref();
  } catch {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    return null;
  }

  return [
    '[MPL] MCP Server (mpl-server) is being built in the background on first install (~60s).',
    'Tools mpl_score_ambiguity, mpl_state_read, mpl_state_write will be unavailable until the build finishes.',
    `Progress log: ${logPath}`,
    'When the build completes, reconnect via /mcp or restart the session to load the server.',
  ].join('\n');
}

async function main() {
  // SessionStart hook receives minimal input (may be empty or have cwd)
  let cwd = process.cwd();

  // Try to read stdin for cwd
  // NOTE: Uses raw stdin instead of lib/stdin.mjs because SessionStart hook
  // has different input format requirements. See mpl-hud.mjs for same pattern.
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString('utf-8').trim();
    if (input) {
      const data = JSON.parse(input);
      cwd = data.cwd || data.directory || cwd;
    }
  } catch { /* use process.cwd() */ }

  // First-install bootstrap: ensure mcp-server is built. Runs on every
  // SessionStart but is a no-op when dist/ + node_modules/ already exist.
  const mcpBuildNotice = ensureMcpServerBuilt();

  const signalFile = join(cwd, '.mpl', 'signals', 'session-handoff.json');

  // Check if handoff signal exists
  if (!existsSync(signalFile)) {
    // No rotation in progress. Still emit the MCP build notice if we kicked off a build.
    if (mcpBuildNotice) {
      console.log(JSON.stringify({ systemMessage: mcpBuildNotice }));
    }
    return;
  }

  // Check signal freshness
  try {
    const stat = statSync(signalFile);
    const age = Date.now() - stat.mtimeMs;
    if (age > HANDOFF_MAX_AGE_MS) {
      // Stale signal - ignore (probably from a previous failed rotation)
      return;
    }
  } catch {
    return;
  }

  // Read handoff data
  let handoff;
  try {
    handoff = JSON.parse(readFileSync(signalFile, 'utf-8'));
  } catch {
    return;
  }

  // Clean up signal file (consumed)
  try { unlinkSync(signalFile); } catch { /* ignore */ }

  // Read current state for context
  let state = {};
  try {
    const statePath = join(cwd, '.mpl', 'state.json');
    if (existsSync(statePath)) {
      state = JSON.parse(readFileSync(statePath, 'utf-8'));
    }
  } catch { /* ignore */ }

  // Read PLAN.md summary for context
  let planSummary = '';
  try {
    const planPath = join(cwd, '.mpl', 'PLAN.md');
    if (existsSync(planPath)) {
      const plan = readFileSync(planPath, 'utf-8');
      // Extract first 2000 chars as summary
      planSummary = plan.substring(0, 2000);
    }
  } catch { /* ignore */ }

  // Build resume context message
  const resumePhase = handoff.resume_from_phase || state.current_phase || 'unknown';
  const pipelineId = handoff.pipeline_id || state.pipeline_id || 'unknown';
  const completedPhases = handoff.completed_phases || state.phases_completed || 0;
  const remainingPhases = handoff.remaining_phases || [];
  const rotationCount = handoff.rotation_count || 0;

  // Build context for the model
  const contextMessage = [
    mcpBuildNotice ? mcpBuildNotice + '\n' : '',
    `[MPL Auto-Resume] Context rotation #${rotationCount + 1} completed.`,
    ``,
    `Pipeline: ${pipelineId}`,
    `Resume from: ${resumePhase}`,
    `Completed phases: ${completedPhases}`,
    remainingPhases.length > 0 ? `Remaining: ${remainingPhases.join(', ')}` : '',
    ``,
    `State file: .mpl/state.json`,
    `Plan file: .mpl/PLAN.md`,
    ``,
    `IMPORTANT: This is an automatic context rotation. The pipeline was paused due to context window limits.`,
    `Execute /mpl:mpl-resume to continue the pipeline from ${resumePhase}.`,
    ``,
    planSummary ? `--- PLAN.md Preview ---\n${planSummary}\n--- End Preview ---` : '',
  ].filter(Boolean).join('\n');

  // Output as system message for context injection
  console.log(JSON.stringify({
    systemMessage: contextMessage,
  }));
}

main().catch(() => {
  // Silent failure - don't break session start
});
