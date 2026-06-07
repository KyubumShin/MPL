/**
 * MPL Observability — Plugin Bootstrap (Move #14 Part 2)
 *
 * Owns the first-install mcp-server build. On a fresh plugin install the
 * plugin cache contains only `mcp-server/src/`, so `dist/` and
 * `node_modules/` are missing and `mpl-server` cannot start. This module
 * manages a build lock, opens log fds, and spawns a detached
 * `npm install && npm run build` child via `child.unref()`.
 *
 * Pure bootstrap — no policy decisions. Lives in observability/ because it
 * only exists to surface a one-time install notice; it never participates
 * in the dispatch routing.
 *
 * Side effects:
 *   - writes `mcp-server/.build-lock`
 *   - appends to `mcp-server/.build.log`
 *   - spawns a detached child process
 *
 * Returns a notice string when a build was kicked off, null otherwise.
 */

import { existsSync, openSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
// hooks/lib/observability/ -> plugin root is 3 levels up
const PLUGIN_ROOT = join(__dirname, '..', '..', '..');

const BUILD_LOCK_MAX_AGE_MS = 300000; // 5min — stale lock cleanup

/**
 * Ensure mcp-server is built. Idempotent and best-effort:
 *   - no-op when mcp-server/ doesn't exist (no plugin context)
 *   - no-op when dist/ + node_modules/ already exist
 *   - no-op when a fresh build is in progress (lock <5min old)
 *   - removes stale locks (>5min)
 *
 * @returns {string | null} notice text when a build was kicked off, null otherwise
 */
export function ensureMcpServerBuilt() {
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
