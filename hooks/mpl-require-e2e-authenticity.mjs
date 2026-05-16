#!/usr/bin/env node
/**
 * MPL E2E Authenticity Guard (PreToolUse on Write|Edit|MultiEdit targeting state.json).
 *
 * `mpl-require-e2e.mjs` proves required scenarios ran and exited 0. This hook
 * proves the scenarios are admissible evidence for the goal contract: real
 * runtime when required, no mock substitution when mock_allowed=false, and no
 * placeholder assertions when placeholder assertions are forbidden.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { readGoalContract } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-contract.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

const REAL_RUNTIME_CLASSES = new Set([
  'real_desktop',
  'real_web',
  'real_browser',
  'real_mobile',
  'real_api',
]);

const MOCK_PATTERN = /\b(mock|stub|fake|msw|mockIPC|VITE_E2E_MOCK|__mocks__)\b/i;
const PLACEHOLDER_PATTERN = /\b(expect\s*\(\s*true\s*\)|assert\s*\(\s*true\s*\)|\.toBe\s*\(\s*true\s*\)|test\.skip\s*\(|it\.skip\s*\(|describe\.skip\s*\()/;

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
}

function normalizeScalar(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed.replace(/^["']|["']$/g, '').trim() || null;
}

function parseInlineList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => normalizeScalar(s))
    .filter(Boolean);
}

function targetPaths(toolInput) {
  const paths = [];
  if (toolInput.file_path) paths.push(toolInput.file_path);
  if (toolInput.filePath) paths.push(toolInput.filePath);
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit?.file_path) paths.push(edit.file_path);
      if (edit?.filePath) paths.push(edit.filePath);
    }
  }
  return paths;
}

function proposedTexts(toolInput) {
  const texts = [];
  for (const key of ['new_string', 'newString', 'content']) {
    if (typeof toolInput[key] === 'string') texts.push(toolInput[key]);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      for (const key of ['new_string', 'newString', 'content']) {
        if (typeof edit?.[key] === 'string') texts.push(edit[key]);
      }
    }
  }
  return texts;
}

function isFinalizeDoneWrite(toolInput) {
  if (!targetPaths(toolInput).some((p) => /\.mpl\/state\.json$/.test(p))) return false;
  // Intentionally re-check any proposed state text that contains
  // finalize_done=true, including state re-serializations after completion:
  // evidence can be deleted or invalidated between final writes.
  return proposedTexts(toolInput).some((text) => /"finalize_done"\s*:\s*true/.test(text));
}

export function parseE2EScenariosText(text) {
  const out = [];
  let cur = null;
  let listField = null;
  let listIndent = -1;

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const idMatch = line.match(/^\s*-\s+id:\s*["']?(E2E-[\w-]+)["']?/);
    if (idMatch) {
      if (cur) out.push(cur);
      cur = {
        id: idMatch[1],
        required: true,
        test_command: null,
        runtime_class: null,
        mock_allowed: null,
        launcher_evidence: null,
        assertion_evidence: null,
        test_files: [],
        forbidden_patterns: [],
      };
      listField = null;
      continue;
    }
    if (!cur) continue;

    const scalar = line.match(/^\s+([a-zA-Z_][\w-]*)\s*:\s*(.+?)\s*$/);
    if (scalar) {
      const [, key, value] = scalar;
      if (value.startsWith('[') && value.endsWith(']')) {
        cur[key] = parseInlineList(value.slice(1, -1));
        listField = null;
        continue;
      }
      if (key === 'required' || key === 'mock_allowed') {
        const normalized = normalizeScalar(value);
        cur[key] = normalized === 'true' ? true : (normalized === 'false' ? false : null);
        listField = null;
        continue;
      }
      if (key in cur) {
        cur[key] = normalizeScalar(value);
        listField = null;
      }
      continue;
    }

    const listStart = line.match(/^(\s+)(test_files|forbidden_patterns)\s*:\s*$/);
    if (listStart) {
      listIndent = listStart[1].length;
      listField = listStart[2];
      continue;
    }

    if (listField) {
      const item = line.match(/^(\s*)-\s+(.+?)\s*$/);
      if (item && item[1].length > listIndent) {
        cur[listField].push(normalizeScalar(item[2]));
        continue;
      }
      listField = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function loadScenarios(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'e2e-scenarios.yaml');
  if (!existsSync(path)) return [];
  try {
    return parseE2EScenariosText(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

function loadOverride(cwd) {
  const path = join(cwd, '.mpl', 'config', 'e2e-authenticity-override.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed?.reason === 'string' && parsed.reason.trim()) return parsed;
  } catch {
    // fall through
  }
  return null;
}

function scanTestFiles(cwd, scenario) {
  const hits = [];
  for (const rel of scenario.test_files || []) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) {
      hits.push(`${scenario.id}:test_file_missing:${rel}`);
      continue;
    }
    let text;
    try { text = readFileSync(abs, 'utf-8'); } catch { continue; }
    if (PLACEHOLDER_PATTERN.test(text)) hits.push(`${scenario.id}:placeholder_assertion:${rel}`);
    for (const pattern of scenario.forbidden_patterns || []) {
      if (pattern && text.includes(pattern)) hits.push(`${scenario.id}:forbidden_pattern:${pattern}:${rel}`);
    }
  }
  return hits;
}

function evaluateScenarioAuthenticity(cwd, scenarios, policy) {
  const issues = [];
  const required = scenarios.filter((s) => s.required !== false && s.test_command);

  for (const scenario of required) {
    if (policy.real_runtime_required !== false && !REAL_RUNTIME_CLASSES.has(scenario.runtime_class)) {
      issues.push(`${scenario.id}:runtime_class=${scenario.runtime_class || 'missing'}`);
    }
    if (policy.real_runtime_required !== false && !scenario.launcher_evidence) {
      issues.push(`${scenario.id}:launcher_evidence_missing`);
    }
    if (policy.mock_allowed === false) {
      if (scenario.mock_allowed === true) issues.push(`${scenario.id}:mock_allowed=true`);
      if (MOCK_PATTERN.test(String(scenario.test_command || ''))) issues.push(`${scenario.id}:mock_token_in_command`);
    }
    if (policy.placeholder_assertions_allowed === false) {
      if (!scenario.assertion_evidence && (!scenario.test_files || scenario.test_files.length === 0)) {
        issues.push(`${scenario.id}:assertion_evidence_missing`);
      }
      issues.push(...scanTestFiles(cwd, scenario));
    }
  }

  return issues;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Write', 'write', 'Edit', 'edit', 'MultiEdit', 'multiEdit'].includes(toolName)) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  if (!isFinalizeDoneWrite(toolInput)) return ok();

  const cfg = loadConfig(cwd);
  if (cfg.e2e_authenticity_required === false) return ok();
  if (loadOverride(cwd)) return ok();

  const goal = readGoalContract(cwd);
  const policy = goal.valid
    ? goal.contract.e2e_policy
    : {
        real_runtime_required: true,
        mock_allowed: false,
        placeholder_assertions_allowed: false,
      };

  const scenarios = loadScenarios(cwd);
  const issues = evaluateScenarioAuthenticity(cwd, scenarios, policy);
  if (issues.length > 0) {
    block(
      `[MPL E2E Authenticity] Cannot set finalize_done=true — required E2E evidence is not authentic: ${issues.join(', ')}. ` +
        'Use real runtime scenarios, remove mock/placeholder substitutes, or record a user-approved override in .mpl/config/e2e-authenticity-override.json.'
    );
    return;
  }

  ok();
}

if (isMain) {
  await main().catch(() => ok());
}
