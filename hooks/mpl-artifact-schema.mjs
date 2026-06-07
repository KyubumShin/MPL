#!/usr/bin/env node
/**
 * MPL Artifact Schema Hook (PostToolUse Edit|Write|MultiEdit|mcp__*__write*) — P0-K / #115.
 *
 * Move #7: thin shim over `hooks/lib/policy/channel-registry.mjs`. The
 * schema-validation slice of the registry runs here. The shim keeps the
 * existing PostToolUse contract intact:
 *
 *   - `decision: 'block'` + reason on validation failure when
 *     enforcement is 'block'
 *   - `continue: true` + systemMessage on warn
 *   - silent + `.mpl/signals/artifact-schema-hits.jsonl` log on off
 *   - CLI mode (finalize Step 5 + doctor Category 6): walks the union of
 *     allowed channels with `schema:` declared
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
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { resolveRuleAction } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-enforcement.mjs')).href
);
const { matchArtifactSchema, validateArtifactFile } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-artifact-schema.mjs')).href
);
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
const { loadChannelRegistry } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'channel-registry.mjs')).href
);

const SIGNALS_RELATIVE = '.mpl/signals/artifact-schema-hits.jsonl';
const HOOK_ID = 'mpl-artifact-schema';

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

function clearCheckedArtifactBlocks(cwd, checkedArtifacts) {
  for (const artifact of checkedArtifacts) {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact });
  }
}

async function main() {
  const input = await readStdin();

  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const toolName = data.tool_name || data.toolName || '';
  // hooks.json matcher routes Edit|Write|MultiEdit|mcp__.*__write.* here;
  // mirror the matcher's regex shape so MCP filesystem writes are not
  // silent-skipped.
  const isWriteTool =
    ['Edit', 'edit', 'Write', 'write', 'MultiEdit', 'multiEdit'].includes(toolName)
    || /^mcp__.*__write/i.test(toolName);
  if (!isWriteTool) return silent();

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
  const checkedArtifacts = [];
  for (const fp of filePaths) {
    const abs = resolve(cwd, fp);
    const rel = workspaceRel(cwd, abs);
    if (!matchArtifactSchema(rel)) continue;
    if (!existsSync(abs)) continue;
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    const verdict = validateArtifactFile(rel, content, { cwd });
    if (!verdict) continue;
    checkedArtifacts.push(verdict.relPath);
    // Always persist signals for audit trail, even when action='off'.
    logHit(cwd, verdict, action);
    if (!verdict.valid) failures.push(verdict);
  }

  if (action === 'off') {
    clearCheckedArtifactBlocks(cwd, checkedArtifacts);
    return silent();
  }
  if (failures.length === 0) {
    clearCheckedArtifactBlocks(cwd, checkedArtifacts);
    return silent();
  }

  const summary = failures.map(formatVerdict).join('\n');

  if (action === 'block') {
    const reason = `[MPL P0-K] artifact schema violation:\n${summary}\n` +
      `Re-emit the artifact with the required sections. Schema: docs/schemas/ (or hooks/lib/mpl-artifact-schema.mjs#ARTIFACT_SCHEMAS).`;
    recordBlockedHook(cwd, {
      hookId: HOOK_ID,
      phaseId: state.current_phase,
      artifact: failures[0]?.relPath || 'artifact-schema',
      code: 'missing_artifact_schema',
      reason,
      resumeInstruction:
        'Re-emit the blocked artifact with the required schema sections, overwriting the invalid version, then retry the next MPL step.',
      retryContext: {
        failures: failures.map((f) => ({
          artifact: f.artifact,
          file: f.relPath,
          missing: f.missing,
          missing_any_of: f.missingAnyOf,
        })),
        schema_reference: 'docs/schemas/',
      },
    });
    console.log(JSON.stringify({
      decision: 'block',
      reason,
    }));
    return;
  }

  console.log(JSON.stringify({
    continue: true,
    systemMessage: `[MPL P0-K] artifact schema advisory:\n${summary}`,
  }));
}

/**
 * CLI mode (P0-K finalize re-check / doctor support).
 *
 *   node hooks/mpl-artifact-schema.mjs <workspaceRoot>
 *
 * Move #7: walks the union of (allowed channels with `schema:`
 * declared) loaded from `hooks/lib/policy/channel-registry.mjs` —
 * single source of truth replacing the hardcoded
 * `enumerateArtifactPaths()` switch. The output contract is preserved:
 * `{ totals: {files, valid, invalid}, results: [...] }` to stdout, exit
 * 1 on any invalid, exit 2 when the workspace path does not exist.
 *
 * Re-exported as `runChannelRegistryCli(workspaceRoot)` so doctor /
 * finalize callers can import without spawning a child process.
 */
export function runChannelRegistryCli(workspaceRoot) {
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) {
    process.stderr.write(`[mpl-artifact-schema] workspace root not found: ${root}\n`);
    process.exit(2);
  }
  const cfg = loadConfig(root);
  const registry = loadChannelRegistry(cfg);

  const candidates = enumerateSchemaBoundPaths(root, registry);
  const results = [];
  for (const rel of candidates) {
    const abs = join(root, rel);
    let content;
    try { content = readFileSync(abs, 'utf-8'); }
    catch { continue; }
    const verdict = validateArtifactFile(rel, content, { cwd: root });
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

function enumerateSchemaBoundPaths(root, registry) {
  const out = [];
  const seen = new Set();
  const allowedWithSchema = (registry.allowed || []).filter((e) => e.schema);

  for (const entry of allowedWithSchema) {
    const literal = entry.path;
    if (!literal.includes('*') && !literal.includes('{')) {
      // Literal path. Also accept `.yml` sibling for legacy `.yaml`
      // declarations so the existing tests that probe both extensions
      // continue to behave the same way.
      const variants = [literal];
      if (literal.endsWith('.yaml')) variants.push(literal.slice(0, -5) + '.yml');
      for (const v of variants) {
        if (existsSync(join(root, v)) && !seen.has(v)) {
          seen.add(v);
          out.push(v);
        }
      }
      continue;
    }
    if (literal.startsWith('.mpl/mpl/phases/phase-*/')) {
      const phasesDir = join(root, '.mpl', 'mpl', 'phases');
      if (!existsSync(phasesDir)) continue;
      let entries = [];
      try { entries = readdirSync(phasesDir, { withFileTypes: true }); } catch {}
      const suffix = literal.slice('.mpl/mpl/phases/phase-*/'.length);
      for (const dirent of entries) {
        if (!dirent.isDirectory()) continue;
        if (!/^phase-/.test(dirent.name)) continue;
        const candidate = `.mpl/mpl/phases/${dirent.name}/${suffix}`;
        if (existsSync(join(root, candidate)) && !seen.has(candidate)) {
          seen.add(candidate);
          out.push(candidate);
        }
      }
    }
  }
  return out;
}

// Hook mode (default — invoked from hooks.json) reads stdin.
// CLI mode triggers when at least one positional arg is present.
const cliArg = process.argv[2];
if (cliArg && !cliArg.startsWith('-')) {
  runChannelRegistryCli(cliArg);
} else {
  await main().catch(() => silent());
}
