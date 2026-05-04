#!/usr/bin/env node
/**
 * MPL Fallback Grep Hook (PostToolUse on Edit|Write|MultiEdit)
 *
 * F3 (#105). Tier 1 anti-pattern observer per commands/references/anti-patterns.md.
 * Path-extension scope filter applied BEFORE regex compile. Hits are appended to
 * `.mpl/signals/anti-pattern-hits.jsonl` for Tier 3 (#112 F5) and adversarial
 * reviewer (#103 P0-A) to consume. Strict mode resolved by
 * `lib/mpl-enforcement.mjs#isStrict` (#110 P0-2) — escalates `severity: block`
 * matches to actual block; default emits a `system-reminder` warn.
 *
 * Self-application contract (PR #120 review): markdown / config files are filtered
 * by extension allowlist before any regex compiles. The registry doc and agent
 * prompts are explicitly excluded so F3/F4 cannot self-fail on the registry's own
 * literal example occurrences.
 */

import { dirname, join, resolve, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { loadRegistry, isInScope, scanContent, decideAction } = await import(
  pathToFileURL(join(__dirname, 'lib', 'anti-pattern-registry.mjs')).href
);
const { resolveRuleAction } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-enforcement.mjs')).href
);

const REGISTRY_RELATIVE = 'commands/references/anti-patterns.md';
const SIGNALS_RELATIVE = '.mpl/signals/anti-pattern-hits.jsonl';

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function workspaceRel(cwd, abs) {
  const cwdAbs = resolve(cwd);
  const path = resolve(abs);
  return path.startsWith(cwdAbs + '/') ? path.slice(cwdAbs.length + 1) : abs;
}

function logHits(cwd, file, hits, action) {
  if (hits.length === 0) return;
  const sigDir = join(cwd, '.mpl', 'signals');
  try { mkdirSync(sigDir, { recursive: true }); } catch {}
  const ts = new Date().toISOString();
  const lines = hits.map(h => JSON.stringify({
    ts,
    file,
    id: h.id,
    severity: h.severity,
    escalation: h.escalation,
    line: h.line,
    snippet: h.snippet,
    regex: h.regex,
    action,
  })).join('\n') + '\n';
  try { appendFileSync(join(cwd, SIGNALS_RELATIVE), lines); } catch {}
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
  // Collect file paths — Edit/Write give one, MultiEdit gives multiple via edits[]
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

  // Locate registry — relative to plugin root (this file lives at hooks/, registry at commands/references/)
  const pluginRoot = resolve(__dirname, '..');
  const registryPath = join(pluginRoot, REGISTRY_RELATIVE);
  if (!existsSync(registryPath)) return silent();

  let registry;
  try { registry = loadRegistry(registryPath); }
  catch { return silent(); }

  const state = readState(cwd) || {};
  // Per-rule policy (P0-2, #110): `anti_pattern_match` controls whether F3
  // surfaces the hit. 'off' = log audit-trail but never surface; 'block' =
  // severity:block hits hard-block; 'warn' = legacy advisory output.
  const ruleAction = resolveRuleAction(cwd, state, 'anti_pattern_match');
  const strict = ruleAction === 'block';

  const allHits = [];
  const blockingDetails = [];
  for (const fp of filePaths) {
    const abs = resolve(cwd, fp);
    if (!isInScope(abs, registry.scope)) continue;
    if (!existsSync(abs)) continue;
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    const hits = scanContent(content, registry.patterns);
    const decision = decideAction(hits, { strict });
    const rel = workspaceRel(cwd, abs);
    // Always persist signals for audit trail, even when ruleAction='off' —
    // F5 (#112) / adversarial reviewer (#103) still consume hits.jsonl.
    logHits(cwd, rel, hits, ruleAction === 'off' ? 'off' : decision.action);
    if (hits.length > 0) {
      allHits.push({ file: rel, hits, decision });
      if (decision.action === 'block') blockingDetails.push({ file: rel, decision });
    }
  }

  // Explicit opt-out: hits logged, no hook-level surfacing.
  if (ruleAction === 'off') return silent();
  if (allHits.length === 0) return silent();

  if (blockingDetails.length > 0) {
    const reasons = blockingDetails.map(b => `${b.file}: ${b.decision.summary}`).join('\n');
    console.log(JSON.stringify({
      decision: 'block',
      reason: `[MPL F3] strict mode anti-pattern block:\n${reasons}`,
    }));
    return;
  }

  const summary = allHits.map(h => `${h.file}: ${h.decision.summary}`).join('\n');
  console.log(JSON.stringify({
    continue: true,
    systemMessage: `[MPL F3] Tier 1 anti-pattern advisory:\n${summary}`,
  }));
}

await main().catch(() => silent());
