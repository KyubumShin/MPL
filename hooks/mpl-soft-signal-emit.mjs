#!/usr/bin/env node
/**
 * MPL Soft-Signal Emitter — thin wrapper (Move #12).
 *
 * Delegates HA-01 vague-delegation detection to
 * `lib/observability/signals.mjs::handleSoftSignalEmit`. The handler
 * returns a `signal` envelope carrying a `sink` of
 *   { kind: 'jsonl', path: '.mpl/mpl/quality-signals.jsonl', record }
 * which the wrapper writes via the existing `mpl-quality-signals.mjs`
 * helper so the file format stays identical for `mpl-doctor` Category 16.
 *
 * Legacy verbatim impl preserved in `mpl-soft-signal-emit.legacy.mjs`.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive } = await import(pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleSoftSignalEmit } = await import(pathToFileURL(join(__dirname, 'lib', 'observability', 'signals.mjs')).href);
const { recordQualitySignal } = await import(pathToFileURL(join(__dirname, 'lib', 'mpl-quality-signals.mjs')).href);

function ok() { console.log(JSON.stringify({ continue: true, suppressOutput: true })); }

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return ok(); }
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const decision = handleSoftSignalEmit({
    event: data.hook_event_name || data.hookEventName || 'PreToolUse',
    toolName: data.tool_name || data.toolName || '',
    toolInput: data.tool_input || data.toolInput || {},
  });

  if (decision && decision.action === 'signal' && decision.sink && decision.sink.kind === 'jsonl') {
    const { record } = decision.sink;
    // Re-route through the canonical writer so format / phase enrichment stays SSOT.
    try {
      recordQualitySignal({
        rule: record.rule,
        severity: record.severity,
        agent: record.agent,
        evidence: record.evidence,
      }, cwd);
    } catch { /* fail-soft */ }
  }
  ok();
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) main().catch(() => ok());

export { detectHa01 } from './lib/observability/signals.mjs';
