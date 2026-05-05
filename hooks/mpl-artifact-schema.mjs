#!/usr/bin/env node
/**
 * MPL Artifact Schema Hook (PostToolUse Edit|Write|MultiEdit) — P0-K / #115.
 *
 * Validates phase artifacts (`decomposition.yaml`, `state-summary.md`,
 * `verification.md`, `pivot-points.md`, `user-contract.md`) against
 * required-section schemas immediately after they're written. Closes
 * the consumer gap that left `enforcement.missing_artifact_schema` as
 * a configured-but-unused rule (F5 #112 forward-compat allow-list).
 *
 * Action precedence: `enforcement.missing_artifact_schema` resolved by
 * `lib/mpl-enforcement.mjs#resolveRuleAction` (P0-2 / #110):
 *   - `warn` (default) → emit a system-reminder listing missing
 *     sections.
 *   - `block` → exit with `decision: 'block'` so the orchestrator
 *     sees the failure and re-emits the artifact.
 *   - `off` → log to `.mpl/signals/artifact-schema-hits.jsonl` only;
 *     no hook-level surfacing.
 *
 * Audit signals are written regardless of policy so finalize / doctor
 * can later replay them.
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync, mkdirSync, appendFileSync, readdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { resolveRuleAction } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-enforcement.mjs')).href
);
const { matchArtifactSchema, validateArtifactFile } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-artifact-schema.mjs')).href
);

const SIGNALS_RELATIVE = '.mpl/signals/artifact-schema-hits.jsonl';

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function workspaceRel(cwd, abs) {
  const cwdAbs = resolve(cwd);
  const path = resolve(abs);
  return path.startsWith(cwdAbs + '/') ? path.slice(cwdAbs.length + 1) : abs;
}

function logHit(cwd, verdict, action) {
  const sigDir = join(cwd, '.mpl', 'signals');
  try { mkdirSync(sigDir, { recursive: true }); } catch {}
  const ts = new Date().toISOString();
  const line = JSON.stringify({
    ts,
    artifact: verdict.artifact,
    file: verdict.relPath,
    valid: verdict.valid,
    missing: verdict.missing,
    missing_any_of: verdict.missingAnyOf,
    action,
  }) + '\n';
  try { appendFileSync(join(cwd, SIGNALS_RELATIVE), line); } catch {}
}

function formatVerdict(verdict) {
  const parts = [];
  if (verdict.missing.length > 0) {
    parts.push(`missing required: ${verdict.missing.join(', ')}`);
  }
  if (verdict.missingAnyOf.length > 0) {
    const groups = verdict.missingAnyOf.map((g) => `(any of: ${g.join(' | ')})`);
    parts.push(`missing one-of: ${groups.join('; ')}`);
  }
  return `${verdict.relPath}: ${parts.join('; ') || 'unknown'}`;
}

async function main() {
  const input = await readStdin();

  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!['Edit', 'edit', 'Write', 'write', 'MultiEdit', 'multiEdit'].includes(toolName)) {
    return silent();
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return silent();

  const toolInput = data.tool_input || data.toolInput || {};
  const filePaths = [];
  if (toolInput.file_path) filePaths.push(toolInput.file_path);
  else if (toolInput.filePath) filePaths.push(toolInput.filePath);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      if (e?.file_path) filePaths.push(e.file_path);
      else if (e?.filePath) filePaths.push(e.filePath);
    }
  }
  if (filePaths.length === 0) return silent();

  const state = readState(cwd) || {};
  const action = resolveRuleAction(cwd, state, 'missing_artifact_schema');

  const failures = [];
  for (const fp of filePaths) {
    const abs = resolve(cwd, fp);
    const rel = workspaceRel(cwd, abs);
    if (!matchArtifactSchema(rel)) continue;
    if (!existsSync(abs)) continue;
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    const verdict = validateArtifactFile(rel, content);
    if (!verdict) continue;
    // Always persist signals for audit trail, even when action='off'.
    logHit(cwd, verdict, action);
    if (!verdict.valid) failures.push(verdict);
  }

  if (action === 'off') return silent();
  if (failures.length === 0) return silent();

  const summary = failures.map(formatVerdict).join('\n');

  if (action === 'block') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: `[MPL P0-K] artifact schema violation:\n${summary}\n` +
        `Re-emit the artifact with the required sections. Schema: docs/schemas/ (or hooks/lib/mpl-artifact-schema.mjs#ARTIFACT_SCHEMAS).`,
    }));
    return;
  }

  console.log(JSON.stringify({
    continue: true,
    systemMessage: `[MPL P0-K] artifact schema advisory:\n${summary}`,
  }));
}

/**
 * CLI mode (P0-K finalize re-check / doctor support):
 *
 *   node hooks/mpl-artifact-schema.mjs <workspaceRoot>
 *
 * Walks every known artifact path under `workspaceRoot` and emits a
 * JSON verdict: `{ totals, results: [{ artifact, file, valid,
 * missing, missing_any_of }] }`. Exit code is 0 when every file is
 * valid (or absent), 1 when at least one validation failed. Designed
 * for finalize Step 5 to gate `finalize_done = true` and for
 * mpl-doctor's Category 6 to surface drift.
 *
 * The CLI uses the same schema / validator the hook does; there is no
 * second source of truth for which sections are required.
 */
function runCli(workspaceRoot) {
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) {
    process.stderr.write(`[mpl-artifact-schema] workspace root not found: ${root}\n`);
    process.exit(2);
  }

  const candidates = enumerateArtifactPaths(root);
  const results = [];
  for (const rel of candidates) {
    const abs = join(root, rel);
    let content;
    try { content = readFileSync(abs, 'utf-8'); }
    catch { continue; }
    const verdict = validateArtifactFile(rel, content);
    if (!verdict) continue;
    results.push({
      artifact: verdict.artifact,
      file: rel,
      valid: verdict.valid,
      missing: verdict.missing,
      missing_any_of: verdict.missingAnyOf,
    });
  }
  const totals = {
    files: results.length,
    valid: results.filter((r) => r.valid).length,
    invalid: results.filter((r) => !r.valid).length,
  };
  process.stdout.write(JSON.stringify({ totals, results }, null, 2) + '\n');
  process.exit(totals.invalid > 0 ? 1 : 0);
}

function enumerateArtifactPaths(root) {
  const out = [];
  // Singletons
  if (existsSync(join(root, '.mpl/mpl/decomposition.yaml'))) out.push('.mpl/mpl/decomposition.yaml');
  if (existsSync(join(root, '.mpl/mpl/decomposition.yml'))) out.push('.mpl/mpl/decomposition.yml');
  if (existsSync(join(root, '.mpl/pivot-points.md'))) out.push('.mpl/pivot-points.md');
  if (existsSync(join(root, '.mpl/requirements/user-contract.md'))) {
    out.push('.mpl/requirements/user-contract.md');
  }
  // Per-phase artifacts
  const phasesDir = join(root, '.mpl/mpl/phases');
  if (existsSync(phasesDir)) {
    let entries = [];
    try { entries = readdirSync(phasesDir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/^phase-/.test(e.name)) continue;
      const ssPath = `.mpl/mpl/phases/${e.name}/state-summary.md`;
      const vPath = `.mpl/mpl/phases/${e.name}/verification.md`;
      if (existsSync(join(root, ssPath))) out.push(ssPath);
      if (existsSync(join(root, vPath))) out.push(vPath);
    }
  }
  return out;
}

// Hook mode (default — invoked from hooks.json) reads stdin.
// CLI mode triggers when at least one positional arg is present.
const cliArg = process.argv[2];
if (cliArg && !cliArg.startsWith('-')) {
  runCli(cliArg);
} else {
  await main().catch(() => silent());
}
