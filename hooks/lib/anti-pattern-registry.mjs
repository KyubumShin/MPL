/**
 * Anti-pattern registry parser + scanner (F2/F3 single-source consumer).
 *
 * Parses commands/references/anti-patterns.md per the BNF grammar declared in
 * §"F3 / F4 parsing contract" of that file:
 *
 *   pattern    := heading frontmatter regex_block permitted_block
 *   heading    := "### " ID " · " Title
 *   frontmatter:= bullet list of: id | category | severity | escalation? | rationale | ground_truth_count
 *   regex_block:= ```regex ... ```
 *   permitted  := ```permitted-when ... ```
 *
 * Plus parses §"## Scope" path-extension allowlist so consumers can apply the
 * filter BEFORE regex compilation (self-application contract: markdown / config
 * files are never scanned, eliminating registry-self-fail).
 */

import { readFileSync } from 'fs';
import { extname } from 'path';

/**
 * Parse the registry markdown into a structured shape.
 *
 * @param {string} md - markdown content
 * @returns {{
 *   scope: { allowed: Set<string>, excluded: Set<string> },
 *   patterns: Array<{
 *     id: string, title: string, category: string,
 *     severity: 'block' | 'warn',
 *     escalation: string[],
 *     rationale: string,
 *     groundTruthCount: string,
 *     regexLines: string[],
 *     permittedWhen: string,
 *   }>
 * }}
 */
export function parseRegistry(md) {
  const lines = md.split('\n');

  // 1. Scope blocks: fenced ```scope and ```scope-excluded
  const scope = { allowed: new Set(), excluded: new Set() };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '```scope' || line === '```scope-excluded') {
      const target = line === '```scope' ? scope.allowed : scope.excluded;
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        const tokens = lines[i].split(/\s+/).filter(Boolean);
        for (const t of tokens) {
          // Skip comments
          if (t.startsWith('#')) break;
          // Take leading dot-extension or wildcard pattern
          if (t.startsWith('.')) target.add(t);
          else if (t.includes('*')) target.add(t);
        }
        i++;
      }
    }
    i++;
  }

  // 2. Patterns: walk ### headings
  const patterns = [];
  i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^### ([A-Za-z0-9.]+) · (.+)$/);
    if (!m) { i++; continue; }
    const pat = {
      id: m[1],
      title: m[2].trim(),
      category: '',
      severity: 'warn',
      escalation: [],
      rationale: '',
      groundTruthCount: '',
      regexLines: [],
      permittedWhen: '',
    };
    i++;
    // Front matter bullets until first fenced block or next heading.
    // PR #122 review fix: previous regex required `\s*$` after the optional closing
    // backtick, dropping any line with trailing prose (e.g. `- **escalation**:
    // \`tier_3_only\` (Tier 1 emits warn only ...)`). The registry intentionally
    // mixes backticked canonical values with explanatory prose, so the parser must
    // accept both forms.
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith('### ') || l.startsWith('```regex') || l.startsWith('```permitted-when')) break;
      const bm = l.match(/^- \*\*([\w\s-]+)\*\*:?\s*(.*)$/);
      if (bm) {
        const key = bm[1].trim().toLowerCase().replace(/\s+/g, '_');
        const rest = bm[2].trim();
        // Extract first backticked code-span as canonical value when present.
        // Backticked = id/category/severity/escalation. Plain prose = rationale,
        // ground-truth count (which may begin with a number then prose).
        const tickMatch = rest.match(/^`([^`]+)`/);
        const val = tickMatch ? tickMatch[1].trim() : rest;
        if (key === 'id') pat.id = val || pat.id;
        else if (key === 'category') pat.category = val;
        else if (key === 'severity') pat.severity = val;
        else if (key === 'escalation') pat.escalation = parseEscalation(val);
        else if (key === 'rationale') pat.rationale = val;
        else if (key === 'ground-truth_count' || key === 'ground_truth_count' || key === 'ground-truth_source' || key === 'ground_truth_source') pat.groundTruthCount = val;
      }
      i++;
    }
    // regex block
    if (i < lines.length && lines[i].startsWith('```regex')) {
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        const rl = lines[i].trim();
        if (rl) pat.regexLines.push(rl);
        i++;
      }
      i++; // closing ```
    }
    // permitted-when block (may be after regex, may not exist)
    while (i < lines.length && !lines[i].startsWith('```permitted-when') && !lines[i].startsWith('### ')) i++;
    if (i < lines.length && lines[i].startsWith('```permitted-when')) {
      i++;
      const buf = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      pat.permittedWhen = buf.join('\n').trim();
      i++; // closing ```
    }
    patterns.push(pat);
  }

  return { scope, patterns };
}

function parseEscalation(val) {
  // Escalation prose may reference: tier_3_only, strict_block, tier_3_block_in: <selector>
  const tokens = [];
  if (/tier_3_only/i.test(val)) tokens.push('tier_3_only');
  if (/strict_block/i.test(val)) tokens.push('strict_block');
  const m = val.match(/tier_3_block_in:\s*([\w-]+)/i);
  if (m) tokens.push(`tier_3_block_in:${m[1]}`);
  return tokens;
}

/**
 * Compile the parsed pattern set into a runtime-ready shape with RegExp objects.
 * Invalid regexes are dropped silently with a count returned for diagnostics.
 *
 * @param {ReturnType<typeof parseRegistry>} parsed
 * @returns {{ patterns: Array<{...parsed.patterns[number], compiled: RegExp[]}>, scope: typeof parsed.scope, dropped: number }}
 */
export function compileRegistry(parsed) {
  let dropped = 0;
  const patterns = parsed.patterns.map(p => {
    const compiled = [];
    for (const rl of p.regexLines) {
      try { compiled.push(new RegExp(rl, 'gm')); }
      catch { dropped++; }
    }
    return { ...p, compiled };
  });
  return { patterns, scope: parsed.scope, dropped };
}

/**
 * Determine whether a file path is in scope for registry enforcement.
 * Path extension allowlist + explicit excluded-pattern check.
 *
 * @param {string} filePath - absolute or workspace-relative path
 * @param {{ allowed: Set<string>, excluded: Set<string> }} scope
 * @returns {boolean}
 */
export function isInScope(filePath, scope) {
  if (!filePath) return false;
  const ext = extname(filePath).toLowerCase();
  if (!scope.allowed.has(ext)) return false;
  // Excluded glob-like patterns: *.test.{ts,tsx,js,jsx,mjs}
  for (const exc of scope.excluded) {
    if (matchesGlob(filePath, exc)) return false;
  }
  // Explicitly exclude self-application surfaces (registry doc + agent prompts)
  if (/commands\/references\/anti-patterns\.md$/.test(filePath)) return false;
  if (/agents\/[^/]+\.md$/.test(filePath)) return false;
  return true;
}

function matchesGlob(filePath, pattern) {
  if (!pattern.includes('*') && !pattern.includes('{')) return false;
  // Translate { , } alternation into regex group, * into [^/]+
  let re = pattern
    .replace(/\./g, '\\.')
    .replace(/\{([^}]+)\}/g, (_, alts) => '(' + alts.split(',').map(s => s.trim()).join('|') + ')')
    .replace(/\*/g, '[^/]+');
  return new RegExp(re + '$').test(filePath);
}

/**
 * Scan file content against compiled patterns. Returns hits keyed by pattern id.
 *
 * @param {string} content - file content
 * @param {ReturnType<typeof compileRegistry>['patterns']} patterns
 * @returns {Array<{ id: string, severity: string, escalation: string[], line: number, snippet: string, regex: string }>}
 */
export function scanContent(content, patterns) {
  const hits = [];
  for (const p of patterns) {
    for (let i = 0; i < p.compiled.length; i++) {
      const re = new RegExp(p.compiled[i].source, p.compiled[i].flags);
      let m;
      let safety = 0;
      while ((m = re.exec(content)) && safety++ < 200) {
        const before = content.slice(0, m.index);
        const line = (before.match(/\n/g) || []).length + 1;
        hits.push({
          id: p.id,
          severity: p.severity,
          escalation: p.escalation,
          line,
          snippet: m[0].slice(0, 200).replace(/\n/g, ' '),
          regex: p.regexLines[i],
        });
        if (m.index === re.lastIndex) re.lastIndex++; // zero-length match safety
      }
    }
  }
  return hits;
}

/**
 * Decide hook outcome from hits + strict mode.
 *
 * Tier 1 (this hook) is observational — it can't evaluate semantic permitted-when
 * exceptions. Default behavior is `warn` for any match. In strict mode, severity:block
 * patterns NOT marked tier_3_only escalate to actual `block`. Tier 3 (#112) is the
 * authoritative consumer for nuanced permitted-when handling.
 *
 * @param {ReturnType<typeof scanContent>} hits
 * @param {{ strict: boolean }} opts
 * @returns {{ action: 'silent' | 'warn' | 'block', summary: string, blocking: typeof hits }}
 */
export function decideAction(hits, opts = {}) {
  if (hits.length === 0) return { action: 'silent', summary: '', blocking: [] };
  const strict = opts.strict === true;
  const blocking = strict
    ? hits.filter(h => h.severity === 'block' && !h.escalation.includes('tier_3_only'))
    : [];
  if (blocking.length > 0) {
    const ids = [...new Set(blocking.map(h => h.id))].join(', ');
    return {
      action: 'block',
      summary: `Anti-pattern violation (strict mode): ${ids}. ${blocking.length} match(es). See commands/references/anti-patterns.md for permitted-when exceptions.`,
      blocking,
    };
  }
  const ids = [...new Set(hits.map(h => h.id))].join(', ');
  return {
    action: 'warn',
    summary: `[MPL anti-pattern] ${hits.length} match(es): ${ids}. Tier 1 advisory — review against commands/references/anti-patterns.md permitted-when before declaring TODO complete.`,
    blocking: [],
  };
}

/**
 * Convenience: load + parse + compile from a registry file path.
 *
 * @param {string} registryPath
 * @returns {ReturnType<typeof compileRegistry>}
 */
export function loadRegistry(registryPath) {
  const md = readFileSync(registryPath, 'utf-8');
  return compileRegistry(parseRegistry(md));
}
