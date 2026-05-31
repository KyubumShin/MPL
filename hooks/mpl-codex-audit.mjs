#!/usr/bin/env node
/**
 * MPL Codex Auditor CLI (F6, #117) — finalize-time Tier 4 sweep.
 *
 * Move #13: thin shim around `hooks/lib/policy/audit.mjs#handleFinalizeAudit`.
 * The wrapper owns I/O (writeFileSync of audit-report.json + stdout +
 * process.exit) and ctx assembly (state + config preloading); the policy
 * module owns the verdict, the surface computation, and the exit-code
 * resolution.
 *
 * Invoked from `commands/mpl-run-finalize.md` Step 5.1.6:
 *
 *   node "${CLAUDE_PLUGIN_ROOT}/hooks/mpl-codex-audit.mjs" "$(pwd)"
 *
 * Writes `<workspaceRoot>/.mpl/mpl/audit-report.json` and emits the same
 * JSON to stdout for the orchestrator to surface.
 *
 * Exit codes (preserved semantics):
 *   0 — audit ran (verdict may be pass OR fail; finalize continues unless
 *       enforcement.audit_residual = 'block')
 *   1 — verdict=fail AND enforcement.audit_residual === 'block'
 *   2 — usage error (missing or invalid workspaceRoot)
 *
 * Pre-Move-#13 byte-identical implementation is preserved at
 * `hooks/mpl-codex-audit.legacy.mjs` for rollback safety.
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, mkdirSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PLUGIN_ROOT = resolve(__dirname, '..');

const { handleFinalizeAudit } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'audit.mjs')).href
);

let loadConfig;
try {
  ({ loadConfig } = await import(
    pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
  ));
} catch {
  loadConfig = () => ({});
}

let readState;
try {
  ({ readState } = await import(
    pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
  ));
} catch {
  readState = () => null;
}

const argRoot = process.argv[2];
const cwd = argRoot ? resolve(argRoot) : process.cwd();

if (!existsSync(cwd)) {
  console.error(JSON.stringify({ error: `workspaceRoot not found: ${cwd}` }));
  process.exit(2);
}

const state = safeReadState(cwd);
const config = safeLoadConfig(cwd);

const envelope = handleFinalizeAudit({
  cwd,
  pluginRoot: PLUGIN_ROOT,
  state,
  config,
});

// Apply sideEffects in declaration order. The envelope carries:
//   { kind:'audit_report_write', path, payload }
//   { kind:'audit_exit_code',    code }
let outPath = null;
let exitCode = 0;
for (const fx of envelope.sideEffects || []) {
  if (fx.kind === 'audit_report_write') {
    const abs = join(cwd, fx.path);
    outPath = abs;
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, JSON.stringify(fx.payload, null, 2) + '\n');
    } catch (err) {
      // Disk write failed — surface but don't lose the JSON; stdout is the
      // primary channel for the orchestrator.
      console.error(JSON.stringify({ warn: `audit-report write failed: ${err.message}` }));
    }
  } else if (fx.kind === 'audit_exit_code') {
    exitCode = fx.code;
  }
}

// Stream the report to stdout for orchestrator surfacing.
const report = envelope.report ?? {
  verdict: envelope.verdict,
  summary: envelope.summary,
  surfaces: envelope.surfaces,
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');

process.exit(exitCode);

function safeReadState(root) {
  try { return readState(root); } catch { return null; }
}
function safeLoadConfig(root) {
  try { return loadConfig(root); } catch { return {}; }
}
