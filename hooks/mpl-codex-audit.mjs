#!/usr/bin/env node
/**
 * MPL Codex Auditor CLI (F6, #117) — finalize-time Tier 4 sweep.
 *
 * Invoked from `commands/mpl-run-finalize.md` Step 5.1.6:
 *
 *   node "${CLAUDE_PLUGIN_ROOT}/hooks/mpl-codex-audit.mjs" "$(pwd)"
 *
 * Writes `<workspaceRoot>/.mpl/mpl/audit-report.json` and emits the same
 * JSON to stdout for the orchestrator to surface.
 *
 * Exit codes:
 *   0 — audit ran (verdict may be pass OR fail; orchestrator surfaces
 *       findings; finalize continues unless enforcement.audit_residual = 'block')
 *   1 — verdict=fail AND enforcement.audit_residual === 'block'
 *       (strict mode — finalize halts; user must address residuals)
 *   2 — usage error (missing or invalid workspaceRoot)
 *
 * Enforcement is read via P0-2 `resolveRuleAction` so the same warn/block/off
 * tri-state pattern as the other Tier-policy hooks applies. Default 'warn'
 * keeps the audit informational unless a project explicitly opts into strict
 * blocking.
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, mkdirSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PLUGIN_ROOT = resolve(__dirname, '..');

const { runCodexAudit } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-codex-audit.mjs')).href
);

let resolveRuleAction;
try {
  ({ resolveRuleAction } = await import(
    pathToFileURL(join(__dirname, 'lib', 'mpl-enforcement.mjs')).href
  ));
} catch {
  // mpl-enforcement.mjs missing → default to 'warn' (graceful degrade so
  // the CLI is still useful in standalone smoke runs).
  resolveRuleAction = () => 'warn';
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

const report = runCodexAudit(cwd, PLUGIN_ROOT);

// Persist alongside other phase artifacts. Directory is created lazily —
// fresh workspaces (no `.mpl/mpl/`) shouldn't fail the audit just because
// the artifact dir doesn't exist yet.
const outDir = join(cwd, '.mpl', 'mpl');
const outPath = join(outDir, 'audit-report.json');
try {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
} catch (err) {
  // Disk write failed — surface but don't lose the JSON; stdout is the
  // primary channel for the orchestrator.
  console.error(JSON.stringify({ warn: `audit-report write failed: ${err.message}` }));
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');

const state = readState(cwd);
const action = resolveRuleAction(cwd, state, 'audit_residual');
if (report.verdict === 'fail' && action === 'block') {
  process.exit(1);
}
process.exit(0);
