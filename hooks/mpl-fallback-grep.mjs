#!/usr/bin/env node
/**
 * MPL Fallback Grep Hook (PostToolUse on Edit|Write|MultiEdit)
 *
 * Thin stdin/stdout shim over `hooks/lib/policy/permit.mjs::handleFallbackGrep`
 * (Move #10). The policy module owns the anti-pattern scan +
 * `decideAction()` + `resolveRuleAction('anti_pattern_match')` decision and
 * returns `logRecords[]` for this wrapper to append. The wrapper owns the
 * jsonl write side effect (mirrors Move #9 finalize-gate's split: policy
 * returns decision, wrapper owns I/O).
 *
 * Original implementation: hooks/mpl-fallback-grep.legacy.mjs
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdirSync, appendFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

const { handleFallbackGrep, PERMIT_SIGNALS_RELATIVE } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'permit.mjs')).href
);

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function writeLogRecords(cwd, logRecords) {
  if (!Array.isArray(logRecords) || logRecords.length === 0) return;
  const sigDir = join(cwd, '.mpl', 'signals');
  try { mkdirSync(sigDir, { recursive: true }); } catch {}
  const lines = logRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
  try { appendFileSync(join(cwd, PERMIT_SIGNALS_RELATIVE), lines); } catch {}
}

async function main() {
  const input = await readStdin();

  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const toolName = data.tool_name || data.toolName || '';
  const cwd = data.cwd || data.directory || process.cwd();
  const toolInput = data.tool_input || data.toolInput || {};
  const pluginRoot = resolve(__dirname, '..');

  const decision = handleFallbackGrep({ cwd, toolName, toolInput, pluginRoot });

  // Append signals (wrapper owns jsonl side effect).
  if (decision.logRecords && decision.logRecords.length > 0) {
    writeLogRecords(cwd, decision.logRecords);
  }

  if (decision.action === 'silent') return silent();

  if (decision.action === 'block') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: decision.reason,
    }));
    return;
  }

  // warn
  console.log(JSON.stringify({
    continue: true,
    systemMessage: decision.reason,
  }));
}

await main().catch(() => silent());
