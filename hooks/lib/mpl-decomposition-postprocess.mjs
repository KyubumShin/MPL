#!/usr/bin/env node
/**
 * Deterministic decomposition post-processing.
 *
 * Keep fields that are mechanical copies or table lookups out of the
 * decomposer's LLM output path. The helpers here derive them from existing
 * artifacts so validators and runners can consume the same data without asking
 * the decomposer to re-emit it on every graph write.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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

function pathValuesFromImpactLine(line) {
  const out = [];
  const direct = String(line || '').match(/^\s*(?:-\s+)?path\s*:\s*(.+?)\s*$/);
  if (direct) {
    const path = normalizeScalar(direct[1].replace(/\s+#.*$/, ''));
    if (path) out.push(path);
  }

  const inline = String(line || '').match(/\bpath\s*:\s*["']?([^"',}\n#]+)["']?/);
  if (inline) {
    const path = normalizeScalar(inline[1]);
    if (path) out.push(path);
  }

  const scalar = String(line || '').match(/^\s*-\s+([^:{\[\]\n#][^:#\n]*)$/);
  if (scalar) {
    const path = normalizeScalar(scalar[1]);
    if (path) out.push(path);
  }

  return out;
}

function collectImpactPathFields(block) {
  const lines = String(block || '').split('\n').map((line) => line.replace(/\r$/, ''));
  const out = [];
  const impactKeys = new Set(['create', 'modify', 'affected_tests', 'affected_config']);

  for (let i = 0; i < lines.length; i += 1) {
    const impactMatch = lines[i].match(/^(\s*)impact\s*:\s*$/);
    if (!impactMatch) continue;

    const impactIndent = impactMatch[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      const indent = lines[j].match(/^(\s*)/)?.[1]?.length || 0;
      if (indent <= impactIndent) break;

      const keyMatch = lines[j].match(/^(\s*)([A-Za-z_]+)\s*:\s*(.*?)\s*$/);
      if (!keyMatch || !impactKeys.has(keyMatch[2])) continue;

      const keyIndent = keyMatch[1].length;
      const inlineValues = pathValuesFromImpactLine(keyMatch[3]);
      out.push(...inlineValues);

      for (let k = j + 1; k < lines.length; k += 1) {
        if (!lines[k].trim()) continue;
        const childIndent = lines[k].match(/^(\s*)/)?.[1]?.length || 0;
        if (childIndent <= keyIndent) {
          j = k - 1;
          break;
        }
        out.push(...pathValuesFromImpactLine(lines[k]));
        if (k === lines.length - 1) j = k;
      }
    }
  }

  return [...new Set(out)];
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
    phase.impact_files = collectImpactPathFields(block);
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
    if (!patternApplies(pattern, langs)) continue;
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

export function buildDerivedDecompositionFieldsFromWorkspace(cwd = process.cwd()) {
  const decompText = readOptional(join(cwd, '.mpl', 'mpl', 'decomposition.yaml'));
  if (!decompText) {
    throw new Error('missing_decomposition');
  }

  const parsed = parseDecompositionPostprocessText(decompText);
  const goal = readGoalContract(cwd);
  const designText = readOptional(join(cwd, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'));
  const designIntent = parseDesignIntentText(designText || '');
  return buildDerivedDecompositionFields({
    decomposition: parsed,
    graph: parsed.graph,
    contract: goal.exists && goal.valid ? goal.contract : null,
    designIntent,
  });
}

export function writeDerivedDecompositionFields(cwd = process.cwd(), derivedRelPath = DEFAULT_DERIVED_PATH) {
  const derived = buildDerivedDecompositionFieldsFromWorkspace(cwd);

  const target = join(cwd, derivedRelPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(derived, null, 2)}\n`);
  return derived;
}

/* ──────────────────── #225: test-agent brief generator ──────────────────── */

/**
 * Per-phase brief extraction from decomposition.yaml.
 *
 * #212 MVP introduced `.mpl/mpl/phases/{phase_id}/test-agent-brief.yaml`
 * as the test-agent execution contract. The brief PRODUCER lives here
 * (#225) — a deterministic post-processor that re-uses the existing
 * decomposition parsers. The decomposer keeps its current responsibility
 * surface; the brief is derived mechanically from fields it already
 * emits (impact.modify, interface_contract.produces, verification_plan
 * A/S items, probing_hints).
 *
 * No new agent dispatch, no new LLM call — just a regex-driven extractor
 * that runs whenever decomposition.yaml is rewritten.
 */

// Indent-aware phase block extractor.
//
// decomposition.yaml has `- id:` lines at the phase level AND nested
// inside `a_items:` / `s_items:` lists (where every A/S item is also
// a `- id: A-1` entry). A naive split on a single `- id:` pattern
// would treat each A/S item as its own "phase". Use the indent of the
// first top-level `phases:` array item to lock in the phase-level
// indent, then only split on `- id:` occurrences at that exact indent.
function extractPhaseBlocks(text) {
  const src = String(text || '');
  const phasesMatch = src.match(/^(\s*)phases\s*:\s*$/m);
  if (!phasesMatch) return [];
  const phasesBlockStart = phasesMatch.index + phasesMatch[0].length;
  const tail = src.slice(phasesBlockStart);
  const firstItem = tail.match(/^([ \t]+)-\s+id\s*:/m);
  if (!firstItem) return [];
  const phaseIndent = firstItem[1];
  const boundary = new RegExp(`^${phaseIndent}-\\s+id\\s*:\\s*(\\S+)`, 'gm');
  const boundaries = [];
  let m;
  while ((m = boundary.exec(tail)) !== null) {
    boundaries.push({ start: m.index, idEnd: m.index + m[0].length, id: normalizeScalar(m[1]) });
  }
  const out = [];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    const next = boundaries[i + 1];
    if (!b.id) continue;
    const body = next ? tail.slice(b.idEnd, next.start) : tail.slice(b.idEnd);
    out.push({ id: b.id, body });
  }
  return out;
}

function parsePhaseTestAgentRequired(body) {
  const m = body.match(/^\s*test_agent_required\s*:\s*(true|false)/im);
  if (!m) return true;
  return m[1].toLowerCase() === 'true';
}

// Codex r4 on PR #226 [security]: the earlier `.replace(/['"]/g, '')`
// stripped ALL quote characters, which silently destroyed inner shell
// quoting. A safe `pytest -k 'login; touch /tmp/pwn'` (one shell argument)
// became `pytest -k login; touch /tmp/pwn` (compound command) once written
// into the brief — and the validator only rejects placeholders, so a
// downstream consumer would execute the injected payload.
//
// Replacement parses YAML scalars conservatively: at most strip one
// matching wrapping pair of `"..."` or `'...'`. Inner quotes survive.
function stripScalar(v) {
  const t = String(v || '').trim();
  if (t.length >= 2 && (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  )) {
    return t.slice(1, -1);
  }
  return t;
}

function parseProducesEntries(body) {
  // Parse `interface_contract.produces:` block within a phase body.
  // Codex r3 on PR #226 [contract-break]: the canonical decomposer
  // schema (agents/mpl-decomposer.md:444-447) emits `{type, name, spec}`.
  // An earlier draft used `{symbol, path}` — accept both shapes for
  // back-compat with hand-authored fixtures, but the canonical write
  // path is `name`/`spec`. The brief's `interface_contracts.symbol` is
  // populated from `name`; `path` is populated from `spec` for the
  // canonical shape (since the decomposer's `produces` doesn't carry
  // a path field — files are in `impact.modify` instead).
  const out = [];
  const idx = body.search(/^\s*produces\s*:\s*$/m);
  if (idx === -1) return out;
  const tail = body.slice(idx).split('\n').slice(1);
  let baseIndent = null;
  let cur = null;
  for (const line of tail) {
    if (/^\s*$/.test(line)) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (baseIndent === null) {
      if (!/^\s*-\s/.test(line)) break;
      baseIndent = indent;
    } else if (indent < baseIndent) {
      break;
    }
    const itemMatch = line.match(/^\s*-\s+([a-z_][a-z0-9_]*)\s*:\s*(.+)$/i);
    if (itemMatch) {
      const [, key, val] = itemMatch;
      cur = {};
      cur[key] = stripScalar(val);
      out.push(cur);
      continue;
    }
    if (cur && /^\s+([a-z_][a-z0-9_]*)\s*:\s*(.+)$/i.test(line)) {
      const [, key, val] = line.match(/^\s+([a-z_][a-z0-9_]*)\s*:\s*(.+)$/i);
      cur[key] = stripScalar(val);
    }
  }
  // Map each entry to the brief's interface_contracts shape:
  //   canonical decomposer: {type, name, spec} → {symbol: name, path: spec}
  //   legacy/test shape:    {symbol, path}     → passes through
  return out.map((entry) => ({
    symbol: entry.symbol || entry.name || '',
    path: entry.path || entry.spec || '',
  })).filter((e) => e.symbol);
}

function parseImpactList(body, key) {
  const out = [];
  const re = new RegExp(`^\\s*${key}\\s*:\\s*$`, 'm');
  const idx = body.search(re);
  if (idx === -1) return out;
  const tail = body.slice(idx).split('\n').slice(1);
  let baseIndent = null;
  for (const line of tail) {
    if (/^\s*$/.test(line)) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (baseIndent === null) {
      if (!/^\s*-\s/.test(line)) break;
      baseIndent = indent;
    } else if (indent < baseIndent) {
      break;
    }
    const m = line.match(/^\s*-\s+(.+)$/);
    if (m) out.push(stripScalar(m[1]));
  }
  return out;
}

function parseAsItemsBlock(body, key) {
  // Codex r3 on PR #226 [contract-break]: the canonical decomposer schema
  // (agents/mpl-decomposer.md:467-476) emits `a_items` / `s_items` as
  //   a_items: [{criterion, type, command}]
  //   s_items: [{criterion, test_file, test_command, expected_exit}]
  // — no explicit `id` field. We parse all scalar fields per item and
  // synthesize an `id` (`A-1`, `A-2`, ...) when absent so downstream
  // consumers can address each item stably.
  //
  // Legacy shape `[{id, statement}]` (used in earlier tests / hand-
  // authored fixtures) is still accepted: `id` overrides synthesis,
  // `statement` is treated as an alias for `criterion`.
  const out = [];
  const re = new RegExp(`^\\s*${key}\\s*:\\s*$`, 'm');
  const idx = body.search(re);
  if (idx === -1) return out;
  const tail = body.slice(idx).split('\n').slice(1);
  let baseIndent = null;
  let cur = null;
  for (const line of tail) {
    if (/^\s*$/.test(line)) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (baseIndent === null) {
      if (!/^\s*-\s/.test(line)) break;
      baseIndent = indent;
    } else if (indent < baseIndent) {
      break;
    }
    const itemMatch = line.match(/^\s*-\s+([a-z_][a-z0-9_]*)\s*:\s*(.+)$/i);
    if (itemMatch) {
      const [, k, v] = itemMatch;
      cur = {};
      cur[k] = stripScalar(v);
      out.push(cur);
      continue;
    }
    if (cur && /^\s+([a-z_][a-z0-9_]*)\s*:\s*(.+)$/i.test(line)) {
      const [, k, v] = line.match(/^\s+([a-z_][a-z0-9_]*)\s*:\s*(.+)$/i);
      cur[k] = stripScalar(v);
    }
  }
  const prefix = key === 's_items' ? 'S' : 'A';
  return out.map((entry, i) => ({
    id: entry.id || `${prefix}-${i + 1}`,
    statement: entry.statement || entry.criterion || '',
    command: entry.command || entry.test_command || '',
    test_file: entry.test_file || '',
  }));
}

function parseProbingHints(body) {
  const out = [];
  const idx = body.search(/^\s*probing_hints\s*:\s*$/m);
  if (idx === -1) return out;
  const tail = body.slice(idx).split('\n').slice(1);
  let baseIndent = null;
  for (const line of tail) {
    if (/^\s*$/.test(line)) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (baseIndent === null) {
      if (!/^\s*-\s/.test(line)) break;
      baseIndent = indent;
    } else if (indent < baseIndent) {
      break;
    }
    const m = line.match(/^\s*-\s+(.+)$/);
    if (m) out.push(stripScalar(m[1]));
  }
  return out;
}

// Codex r1 on PR #226 [security]: `decomposition.yaml` is project-internal,
// but a malicious or buggy impact path like `src/x.ts; rm -rf /` would be
// interpolated straight into the command string the test-agent later runs.
// Treat impact paths as untrusted. A safe path is a repo-relative filename
// with no shell metacharacters, no whitespace, no NUL, no `..` segments.
// Anything outside that shape falls back to a path-less command so the
// command is still non-placeholder (validator-friendly) but un-injectable.
function isSafeRelativePath(p) {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > 256) return false;
  if (/[\s;&|`$<>(){}\[\]\\'"*?!#~\x00]/.test(p)) return false;
  if (p.startsWith('/') || p.startsWith('-')) return false;
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(p);
}

function deriveTestCommandsForPhase(phaseLang, targetFiles) {
  // Map phase_lang to a sensible default test command. Operators can
  // override by hand-editing the brief; this just gives the mechanical
  // generator a non-placeholder starting point so #224's strict
  // validator (placeholder/echo rejection) doesn't trip immediately.
  const lang = String(phaseLang || '').toLowerCase();
  const raw = targetFiles.length > 0 ? targetFiles[0] : '';
  const safe = isSafeRelativePath(raw) ? raw : '';
  if (/ts|typescript|tsx|js|javascript/.test(lang)) {
    return [safe ? `npm test -- ${safe}` : 'npm test'];
  }
  if (/rust|cargo/.test(lang)) {
    return [`cargo test --package-affected`];
  }
  if (/py|python/.test(lang)) {
    return [safe ? `pytest ${safe}` : 'pytest'];
  }
  if (/go|golang/.test(lang)) {
    return [`go test ./...`];
  }
  // Fallback: a non-placeholder but generic command that operators MUST
  // replace. Use the project's npm test as the safest default.
  return ['npm test'];
}

function yamlString(s) {
  // Conservative quoting: wrap in double quotes, escape embedded quotes.
  return `"${String(s || '').replace(/"/g, '\\"')}"`;
}

function renderBriefYaml(brief) {
  const lines = [];
  lines.push('# Auto-generated by hooks/lib/mpl-decomposition-postprocess.mjs (#225)');
  lines.push('# Source: .mpl/mpl/decomposition.yaml. Re-derived on every');
  lines.push('# decomposition write. Manual edits will be overwritten on the');
  lines.push('# next postprocess run — change the source decomposition instead.');
  lines.push('');
  lines.push(`phase_id: ${yamlString(brief.phase_id)}`);
  lines.push(`phase_domain: ${yamlString(brief.phase_domain || '')}`);
  lines.push(`phase_name: ${yamlString(brief.phase_name || brief.phase_id)}`);
  lines.push('target_implementation_files:');
  for (const f of brief.target_implementation_files) lines.push(`  - ${yamlString(f)}`);
  lines.push('interface_contracts:');
  for (const c of brief.interface_contracts) {
    lines.push(`  - symbol: ${yamlString(c.symbol)}`);
    if (c.path) lines.push(`    path: ${yamlString(c.path)}`);
  }
  lines.push('a_item_coverage:');
  for (const a of brief.a_item_coverage) {
    lines.push(`  - id: ${yamlString(a.id)}`);
    lines.push(`    test_target: ${yamlString(a.test_target)}`);
  }
  lines.push('s_item_coverage:');
  for (const s of brief.s_item_coverage) {
    lines.push(`  - id: ${yamlString(s.id)}`);
    lines.push(`    test_target: ${yamlString(s.test_target)}`);
  }
  lines.push('required_test_commands:');
  for (const c of brief.required_test_commands) lines.push(`  - ${yamlString(c)}`);
  if (brief.probing_targets.length > 0) {
    lines.push('probing_targets:');
    for (const p of brief.probing_targets) lines.push(`  - ${yamlString(p)}`);
  }
  lines.push('forbidden_conditions:');
  for (const f of brief.forbidden_conditions) lines.push(`  - ${yamlString(f)}`);
  return lines.join('\n') + '\n';
}

/**
 * Build the per-phase brief from a single phase block + the phase
 * metadata that the existing parsers extract.
 */
function buildBriefFromPhaseBlock(phase, body) {
  const phaseId = phase.id;
  const targetFiles = phaseImpactFiles(phase);
  const interfaceContracts = parseProducesEntries(body);
  const aItems = parseAsItemsBlock(body, 'a_items');
  const sItems = parseAsItemsBlock(body, 's_items');
  const probingHints = parseProbingHints(body);

  // Codex r3 on PR #226 [contract-break]: the canonical decomposer
  // emits per-s_item `test_command` strings (e.g., `pytest path/to/x.py
  // -k case`). Prefer those over the language-derived default — if at
  // least one S-item has a concrete `test_command`, use the de-duplicated
  // set; otherwise fall back to `deriveTestCommandsForPhase`.
  //
  // Codex r4/r5 on PR #226 [security]: even with proper YAML scalar
  // parsing, command strings are still ultimately consumed by the
  // test-agent as shell commands. The earlier (r4) quote-aware scanner
  // could be bypassed with escaped quotes (codex r5: `\'` outside any
  // quoted region opens an `inSingle` state in our scanner but is just
  // a literal quote to the shell, so a trailing `;` outside the
  // pseudo-quoted region executes).
  //
  // Fail-closed policy: reject any command containing shell
  // separators or substitutions ANYWHERE (no quote-state tracking).
  // Legitimate test commands (`pytest path -k filter`,
  // `npm test -- path`, etc.) don't need these characters, and any
  // decomposer-emitted command that does is structurally suspicious.
  // Rejected commands fall back to the language default, which is
  // never a shell-compound command.
  function isLikelyInjection(cmd) {
    return /;|&&|\|\||`|\$\(/.test(cmd);
  }
  const sItemCommands = sItems
    .map((it) => it.command)
    .filter((c) => typeof c === 'string' && c.trim().length >= 5)
    .map((c) => c.trim())
    .filter((c) => !isLikelyInjection(c));
  const dedupedSItemCommands = [...new Set(sItemCommands)];
  const aItemCommands = aItems
    .map((it) => it.command)
    .filter((c) => typeof c === 'string' && c.trim().length >= 5)
    .map((c) => c.trim())
    .filter((c) => !isLikelyInjection(c));
  const dedupedAItemCommands = [...new Set(aItemCommands)];
  const decomposerCommands = [...dedupedSItemCommands, ...dedupedAItemCommands];
  const requiredTestCommands = decomposerCommands.length > 0
    ? decomposerCommands
    : deriveTestCommandsForPhase(phase.phase_lang, targetFiles);

  return {
    phase_id: phaseId,
    phase_domain: phase.phase_domain || '',
    phase_name: phaseId,
    target_implementation_files: targetFiles,
    interface_contracts: interfaceContracts,
    a_item_coverage: aItems.map((it) => ({
      id: it.id,
      test_target: it.statement || `Verify ${it.id} via ${targetFiles[0] || 'the implementation files'}`,
    })),
    s_item_coverage: sItems.map((it) => ({
      id: it.id,
      test_target: it.statement || `Verify ${it.id} via ${targetFiles[0] || 'the implementation files'}`,
    })),
    required_test_commands: requiredTestCommands,
    probing_targets: probingHints,
    forbidden_conditions: [
      'Mock or stub the implementation under test',
      'Placeholder assertions (expect(true).toBe(true), TODO comments)',
    ],
  };
}

/**
 * Write `.mpl/mpl/phases/{phase_id}/test-agent-brief.yaml` for every
 * phase in decomposition.yaml that has `test_agent_required != false`.
 *
 * Idempotent: re-derives every brief from the current decomposition on
 * each call. Manual edits are intentionally NOT preserved — the brief
 * is a derived artifact (see header comment in the rendered YAML).
 *
 * Returns the list of written phase ids.
 */
export function writeTestAgentBriefs(cwd = process.cwd()) {
  const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  const parsed = parseDecompositionPostprocessText(text);
  const blocks = extractPhaseBlocks(text);
  const blockById = new Map(blocks.map((b) => [b.id, b.body]));
  const written = [];
  for (const phase of parsed.phases) {
    const body = blockById.get(phase.id);
    if (!body) continue;
    if (!parsePhaseTestAgentRequired(body)) continue;
    const brief = buildBriefFromPhaseBlock(phase, body);
    const briefPath = join(cwd, '.mpl', 'mpl', 'phases', phase.id, 'test-agent-brief.yaml');
    mkdirSync(dirname(briefPath), { recursive: true });
    writeFileSync(briefPath, renderBriefYaml(brief));
    written.push(phase.id);
  }
  return written;
}

function runCli() {
  const args = new Set(process.argv.slice(2));
  const cwdArg = process.argv.find((arg) => arg.startsWith('--cwd='));
  const cwd = cwdArg ? cwdArg.slice('--cwd='.length) : process.cwd();
  let derived;
  try {
    derived = args.has('--write-json')
      ? writeDerivedDecompositionFields(cwd)
      : buildDerivedDecompositionFieldsFromWorkspace(cwd);
  } catch (error) {
    console.log(JSON.stringify({ error: error?.message || 'postprocess_failed' }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(derived, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runCli();
}
