#!/usr/bin/env node
/**
 * Deterministic decomposition post-processing.
 *
 * Keep fields that are mechanical copies or table lookups out of the
 * decomposer's LLM output path. The helpers here derive them from existing
 * artifacts so validators and runners can consume the same data without asking
 * the decomposer to re-emit it on every graph write.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { parseDecompositionGoalTraceText, deriveMvpFromGoalTrace } from './mpl-goal-trace.mjs';
import { parsePhaseContractGraphText } from './mpl-phase-contract-graph.mjs';
import { readGoalContract } from './mpl-goal-contract.mjs';

const DEFAULT_DERIVED_PATH = '.mpl/mpl/decomposition-derived.json';

export const DEFAULT_RISK_PATTERNS = Object.freeze([
  Object.freeze({
    pattern_id: 'sec-eval',
    grep_pattern: '\\beval\\(',
    severity: 'EXPERIMENTAL',
    target_langs: Object.freeze(['js', 'ts', 'py']),
  }),
  Object.freeze({
    pattern_id: 'sec-api-key',
    grep_pattern: '(api_key|apikey|secret)\\s*[:=]\\s*["\'][^"\']{8,}',
    severity: 'EXPERIMENTAL',
    target_langs: Object.freeze(['*']),
  }),
  Object.freeze({
    pattern_id: 'sec-sql-concat',
    grep_pattern: '["\']\\s*\\+\\s*\\w+.*(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)',
    severity: 'EXPERIMENTAL',
    target_langs: Object.freeze(['js', 'ts', 'py', 'java']),
  }),
  Object.freeze({
    pattern_id: 'sec-innerhtml',
    grep_pattern: '\\.innerHTML\\s*=',
    severity: 'EXPERIMENTAL',
    target_langs: Object.freeze(['js', 'ts']),
  }),
  Object.freeze({
    pattern_id: 'sec-weak-crypto',
    grep_pattern: 'Math\\.random\\(\\)',
    severity: 'EXPERIMENTAL',
    target_langs: Object.freeze(['js', 'ts']),
  }),
]);

const EXT_LANG = new Map([
  ['.js', 'js'],
  ['.jsx', 'js'],
  ['.mjs', 'js'],
  ['.cjs', 'js'],
  ['.ts', 'ts'],
  ['.tsx', 'ts'],
  ['.py', 'py'],
  ['.java', 'java'],
  ['.rs', 'rust'],
  ['.go', 'go'],
]);

const PHASE_LANG = new Map([
  ['javascript', 'js'],
  ['typescript', 'ts'],
  ['python', 'py'],
  ['java', 'java'],
  ['rust', 'rust'],
  ['go', 'go'],
]);

function normalizeScalar(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed.replace(/^["']|["']$/g, '').trim() || null;
}

function parseInlineList(value) {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((s) => normalizeScalar(s))
    .filter(Boolean);
}

function parseListField(block, key) {
  const lines = String(block || '').split('\n').map((line) => line.replace(/\r$/, ''));
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\s*)${escaped}\\s*:\\s*(.*?)\\s*$`);
  const idx = lines.findIndex((line) => re.test(line));
  if (idx === -1) return [];

  const match = lines[idx].match(re);
  const baseIndent = match[1].length;
  const value = match[2] || '';
  const inline = parseInlineList(value);
  if (inline) return inline;
  const scalar = normalizeScalar(value);
  if (scalar) return [scalar];

  const out = [];
  for (const line of lines.slice(idx + 1)) {
    if (!line.trim()) continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length || 0;
    if (indent <= baseIndent) break;
    const item = line.match(/^\s*-\s+(.+?)\s*$/);
    if (!item) continue;
    const parsed = normalizeScalar(item[1]);
    if (parsed) out.push(parsed);
  }
  return out;
}

function scalarField(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(block || '').match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, 'm'));
  return m ? normalizeScalar(m[1]) : null;
}

function collectPathFields(block) {
  const out = [];
  for (const match of String(block || '').matchAll(/^\s*(?:-\s+)?path\s*:\s*["']?([^"'\n]+)["']?\s*$/gm)) {
    const path = normalizeScalar(match[1]);
    if (path) out.push(path);
  }
  return out;
}

function parseRiskPatternBlocks(block) {
  if (!/^\s+risk_patterns\s*:/m.test(block || '')) return [];
  const out = [];
  const itemRe = /^\s*-\s+pattern_id\s*:\s*["']?([^"'\n#]+)["']?\s*$/gm;
  for (const match of String(block).matchAll(itemRe)) {
    const start = match.index;
    const next = String(block).slice(start + match[0].length).search(/^\s*-\s+pattern_id\s*:/m);
    const itemText = next === -1
      ? String(block).slice(start)
      : String(block).slice(start, start + match[0].length + next);
    const patternId = normalizeScalar(match[1]);
    const grepPattern = scalarField(itemText, 'grep_pattern');
    const severity = scalarField(itemText, 'severity') || 'EXPERIMENTAL';
    const targetLangs = parseListField(itemText, 'target_langs');
    if (patternId && grepPattern) {
      out.push({
        pattern_id: patternId,
        grep_pattern: grepPattern,
        severity,
        target_langs: targetLangs,
      });
    }
  }
  return out;
}

export function parseDecompositionPostprocessText(text) {
  const goalTrace = parseDecompositionGoalTraceText(text);
  const graph = parsePhaseContractGraphText(text);
  const byId = new Map(goalTrace.phases.map((phase) => [phase.id, { ...phase }]));

  const blocks = String(text || '').split(/^\s*-\s+id:\s*/m).slice(1);
  for (const block of blocks) {
    const firstLine = block.split('\n')[0] || '';
    const id = normalizeScalar(firstLine);
    if (!id) continue;
    const phase = byId.get(id) || { id };
    phase.phase_domain = scalarField(block, 'phase_domain');
    phase.phase_lang = scalarField(block, 'phase_lang');
    phase.impact_files = collectPathFields(block);
    phase.risk_patterns = parseRiskPatternBlocks(block);
    byId.set(id, phase);
  }

  return {
    goal_contract_hash: goalTrace.goal_contract_hash,
    phases: goalTrace.phases.map((phase) => byId.get(phase.id) || phase),
    graph,
  };
}

function extensionOf(path) {
  const match = String(path || '').toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : '';
}

export function phaseImpactFiles(phase) {
  const files = new Set();
  for (const key of ['create', 'modify', 'affected_tests', 'affected_config']) {
    const entries = phase?.impact?.[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry === 'string') files.add(entry);
      else if (entry && typeof entry.path === 'string') files.add(entry.path);
    }
  }
  for (const path of phase?.impact_files || []) {
    if (typeof path === 'string') files.add(path);
  }
  return [...files];
}

export function detectPhaseLangs(phase) {
  const langs = new Set();
  const declared = PHASE_LANG.get(String(phase?.phase_lang || '').toLowerCase());
  if (declared) langs.add(declared);
  for (const path of phaseImpactFiles(phase)) {
    const lang = EXT_LANG.get(extensionOf(path));
    if (lang) langs.add(lang);
  }
  return [...langs];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function patternApplies(pattern, langs) {
  const targets = Array.isArray(pattern?.target_langs) ? pattern.target_langs : [];
  if (targets.includes('*')) return true;
  return targets.some((lang) => langs.includes(lang));
}

function filesForPattern(pattern, files) {
  const targets = Array.isArray(pattern?.target_langs) ? pattern.target_langs : [];
  if (targets.length === 0 || targets.includes('*')) return files;
  return files.filter((path) => targets.includes(EXT_LANG.get(extensionOf(path))));
}

function toPatternAItem(pattern, files, source) {
  return {
    pattern_id: pattern.pattern_id,
    source,
    criterion: `AD-0005 EXPERIMENTAL: ${pattern.pattern_id}`,
    type: 'grep',
    command: `grep -rnE ${shellQuote(pattern.grep_pattern)} ${files.map(shellQuote).join(' ')}`,
    severity: pattern.severity || 'EXPERIMENTAL',
  };
}

export function deriveRiskPatternChecks(phase) {
  const files = phaseImpactFiles(phase);
  if (files.length === 0) return [];

  const langs = detectPhaseLangs(phase);
  const seen = new Set();
  const checks = [];

  for (const pattern of DEFAULT_RISK_PATTERNS) {
    if (!patternApplies(pattern, langs)) continue;
    const targetFiles = filesForPattern(pattern, files);
    if (targetFiles.length === 0) continue;
    checks.push(toPatternAItem(pattern, targetFiles, 'default'));
    seen.add(`${pattern.pattern_id}\0${pattern.grep_pattern}`);
  }

  for (const pattern of phase?.risk_patterns || []) {
    if (!pattern?.pattern_id || !pattern?.grep_pattern) continue;
    const key = `${pattern.pattern_id}\0${pattern.grep_pattern}`;
    if (seen.has(key)) continue;
    const targetFiles = filesForPattern(pattern, files);
    if (targetFiles.length === 0) continue;
    checks.push(toPatternAItem(pattern, targetFiles, 'project'));
    seen.add(key);
  }

  return checks;
}

export function parseDesignIntentText(text) {
  const invariants = [];
  if (!/^invariants\s*:/m.test(String(text || ''))) return { invariants };

  const lines = String(text || '').split('\n').map((line) => line.replace(/\r$/, ''));
  const start = lines.findIndex((line) => /^invariants\s*:\s*$/.test(line));
  if (start === -1) return { invariants };

  const blocks = [];
  let cur = null;
  const flush = () => {
    if (cur) blocks.push(cur.join('\n'));
    cur = null;
  };

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/^\s*-\s+id\s*:/.test(line)) {
      flush();
      cur = [line.replace(/^(\s*)-\s+/, '$1  ')];
      continue;
    }
    if (cur) cur.push(line);
  }
  flush();

  for (const block of blocks) {
    const id = scalarField(block, 'id');
    const statement = scalarField(block, 'statement');
    const verify = scalarField(block, 'verify');
    const applies = parseListField(block, 'applies_to_phases');
    if (id && statement && verify) {
      invariants.push({ id, statement, verify, applies_to_phases: applies });
    }
  }

  return { invariants };
}

export function deriveInvariantsForPhase(phaseId, designIntent) {
  if (!phaseId) return [];
  const invariants = Array.isArray(designIntent?.invariants) ? designIntent.invariants : [];
  return invariants
    .filter((inv) => {
      const applies = Array.isArray(inv.applies_to_phases) ? inv.applies_to_phases : [];
      return applies.length === 0 || applies.includes(phaseId);
    })
    .map((inv) => ({
      id: inv.id,
      statement: inv.statement,
      verify: inv.verify,
    }));
}

export function buildDerivedDecompositionFields({ decomposition, graph = null, contract = null, designIntent = null }) {
  const phaseOrder = graph?.execution_tier_phase_refs || null;
  const phases = decomposition?.phases || [];
  const byPhase = {};

  for (const phase of phases) {
    byPhase[phase.id] = {
      risk_pattern_checks: deriveRiskPatternChecks(phase),
      invariants: deriveInvariantsForPhase(phase.id, designIntent),
    };
  }

  return {
    generated_by: 'mpl-decomposition-postprocess',
    mvp: deriveMvpFromGoalTrace(decomposition, contract, phaseOrder),
    phases: byPhase,
  };
}

function readOptional(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function runCli() {
  const args = new Set(process.argv.slice(2));
  const cwdArg = process.argv.find((arg) => arg.startsWith('--cwd='));
  const cwd = cwdArg ? cwdArg.slice('--cwd='.length) : process.cwd();
  const decompText = readOptional(join(cwd, '.mpl', 'mpl', 'decomposition.yaml'));
  if (!decompText) {
    console.log(JSON.stringify({ error: 'missing_decomposition' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const parsed = parseDecompositionPostprocessText(decompText);
  const goal = readGoalContract(cwd);
  const designText = readOptional(join(cwd, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'));
  const designIntent = parseDesignIntentText(designText || '');
  const derived = buildDerivedDecompositionFields({
    decomposition: parsed,
    graph: parsed.graph,
    contract: goal.exists && goal.valid ? goal.contract : null,
    designIntent,
  });

  if (args.has('--write-json')) {
    writeFileSync(join(cwd, DEFAULT_DERIVED_PATH), `${JSON.stringify(derived, null, 2)}\n`);
  }
  console.log(JSON.stringify(derived, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runCli();
}
