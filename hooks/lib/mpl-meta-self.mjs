/**
 * MPL Doctor Meta-Self Audit (F4, #106)
 *
 * Closes the audit hole where `mpl-doctor` itself was excluded from anti-pattern
 * grep — v3.10 §3.1 retrofit findings #6 (`?? ''` 4 occurrences) and #7 (Pattern
 * 5 self-exemption regex). doctor must scan its own source AND surface explicit
 * self-exemptions AND require every diagnostic Category to declare a `Scope`
 * glob list (R-DOCTOR-SCOPE-LEAK).
 *
 * Pure functions. No process side effects beyond reading the plugin tree.
 *
 * Audit produces 4 surfaces:
 *   1. anti_pattern_hits — F3 registry patterns scanned over doctor's own files
 *      (agents/mpl-doctor.md + hooks/mpl-doctor*.mjs + lib helpers).
 *   2. self_exemption_hits — explicit self-exclude regex inside doctor source.
 *   3. missing_scope — Categories that lack a `**Scope**:` glob declaration.
 *   4. inverse_audit_hits — anti-pattern hits in directories OUTSIDE F3 scope
 *      (`scripts/`, `agents/`, `commands/`) that doctor should still audit.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, resolve, relative, extname } from 'path';

import { loadRegistry, scanContent } from './anti-pattern-registry.mjs';

/* ────────────────────────── Doctor source enumeration ─────────────────────── */

/**
 * Files that constitute "doctor's own surface". Anti-pattern hits in these are
 * meta-self findings — doctor must catch them in itself before pretending to
 * audit the rest of the codebase.
 */
const DOCTOR_SELF_SOURCES = [
  'agents/mpl-doctor.md',
  'skills/mpl-doctor/SKILL.md',
];

const DOCTOR_LIB_GLOBS = [
  // hooks/mpl-doctor*.mjs and hooks/lib/mpl-doctor*.mjs (none ship today,
  // but anything matching becomes a doctor surface automatically).
  { dir: 'hooks', re: /^mpl-doctor.*\.mjs$/ },
  { dir: 'hooks/lib', re: /^mpl-doctor.*\.mjs$/ },
];

function listMatchingFiles(pluginRoot, { dir, re }) {
  const abs = join(pluginRoot, dir);
  if (!existsSync(abs)) return [];
  try {
    return readdirSync(abs)
      .filter((name) => re.test(name))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export function enumerateDoctorSources(pluginRoot) {
  const explicit = DOCTOR_SELF_SOURCES.filter((rel) =>
    existsSync(join(pluginRoot, rel)),
  );
  const dynamic = DOCTOR_LIB_GLOBS.flatMap((spec) => listMatchingFiles(pluginRoot, spec));
  // De-dupe, preserve relative paths.
  return [...new Set([...explicit, ...dynamic])];
}

/* ────────────────────────── Markdown prose stripper ──────────────────────── */

/**
 * Reduce markdown content to just its fenced code blocks (```...```) so audits
 * ignore inline-code reference prose. Without this, doctor documenting its own
 * findings (e.g. mentioning `?? ''` as a v3.10 finding, or `if (file.endsWith
 * ('mpl-doctor.md')) skip` as an example self-exemption shape) would self-match
 * every audit run. Lines outside fenced blocks are blanked to keep line numbers
 * intact for surface messages.
 *
 * @param {string} markdown
 * @returns {string}
 */
function stripMarkdownProse(markdown) {
  const lines = markdown.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return ''; // fence delimiter itself is not code
      }
      return inFence ? line : '';
    })
    .join('\n');
}

/* ────────────────────────── Self-exemption detection ──────────────────────── */

/**
 * Regex set that flags explicit self-exclusion of doctor from audits.
 * Each pattern carries an `id` so the surface message can name the kind.
 *
 * v3.10 §3.1 #7 cited a Pattern 5 self-exemption regex inside doctor —
 * something like `if (file.endsWith('mpl-doctor.md')) skip` would self-exempt
 * the doctor surface from anti-pattern audits. Anything that names "doctor"
 * as a skip target deserves explicit user review.
 */
const SELF_EXEMPTION_PATTERNS = [
  // Code-shape only — control-flow that names doctor as a skip target.
  // Patterns are line-anchored (`detectSelfExemption` scans line-by-line) so
  // `.*` cannot bleed across statements. Prose must not match — these all
  // require both `mpl-doctor` AND a control-flow keyword in the same line.
  { id: 'self-exempt-conditional', regex: /\bif\b.*\bmpl-?doctor\b.*\)\s*\{?\s*(?:return|continue|skip|next|break)/i },
  // Array filter rejecting doctor source paths.
  // No `\b` before `!==` — `!` is non-word, the boundary check fails on whitespace.
  { id: 'self-exempt-filter-out', regex: /\.\s*(?:filter|reject)\s*\(.*(?:!==|!=)\s*['"][^'"]*mpl-doctor[^'"]*['"]/i },
  // Skip / deny / exclude assignment naming doctor.
  { id: 'self-exempt-deny-list', regex: /\b(?:exclude[ds]?|deny|skip)\s*[:=]\s*\[?\s*['"][^'"]*mpl-doctor[^'"]*['"]/i },
  // Negative regex lookahead naming doctor (Pattern 5 shape from v3.10 §3.1 #7).
  { id: 'self-exempt-negative-regex', regex: /\(\?!\s*[^)]*mpl-doctor/i },
];

export function detectSelfExemption(pluginRoot, sources = null) {
  const files = sources ?? enumerateDoctorSources(pluginRoot);
  const hits = [];
  for (const rel of files) {
    const abs = join(pluginRoot, rel);
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    // For markdown surfaces (agents/mpl-doctor.md, skills/mpl-doctor/SKILL.md),
    // only fenced code blocks are inspected — Category 14's own prose mentions
    // example code shapes like `if (file.endsWith('mpl-doctor.md')) skip` and
    // those would otherwise self-match. Real .mjs source is scanned in full.
    const scanText = rel.endsWith('.md') ? stripMarkdownProse(content) : content;
    const lines = scanText.split('\n');
    for (const pat of SELF_EXEMPTION_PATTERNS) {
      lines.forEach((line, i) => {
        const m = line.match(pat.regex);
        if (m) {
          hits.push({
            id: pat.id,
            file: rel,
            line: i + 1,
            snippet: line.trim().slice(0, 200),
            regex: pat.regex.source,
          });
        }
      });
    }
  }
  return hits;
}

/* ────────────────────────── Scope manifest validation ─────────────────────── */

/**
 * Parse `agents/mpl-doctor.md` and identify diagnostic Categories. A Category
 * is a `### Category N: <name>` heading. Each Category MUST declare a
 * `**Scope**: <glob-list>` line within its body before the next `###` heading.
 *
 * Categories that lack a Scope declaration are flagged — the audit cannot
 * verify what files they cover, which is exactly the R-DOCTOR-SCOPE-LEAK
 * pattern (e.g. spec-citations only checking `src/` while ignoring `scripts/`).
 *
 * Returns:
 *   { categories: [{ id, title, hasScope, scopeText }], missing: [{ id, title }] }
 */
export function validateScopeManifest(pluginRoot) {
  const docPath = join(pluginRoot, 'agents', 'mpl-doctor.md');
  if (!existsSync(docPath)) {
    return { categories: [], missing: [], error: 'agents/mpl-doctor.md not found' };
  }
  const content = readFileSync(docPath, 'utf-8');
  const lines = content.split('\n');

  const categories = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^\s*###\s+Category\s+(\d+(?:\.\d+)?):\s*(.+?)\s*$/);
    if (headingMatch) {
      if (cur) categories.push(cur);
      cur = {
        id: headingMatch[1],
        title: headingMatch[2].trim(),
        hasScope: false,
        scopeText: null,
        line: i + 1,
      };
      continue;
    }
    if (!cur) continue;
    // Scope declaration: bold "Scope" key followed by a glob/path list.
    // Accept either inline form ("**Scope**: src/**/*.ts, scripts/**") or
    // hyphen list under a "**Scope**:" line.
    const scopeMatch = line.match(/\*\*Scope\*\*:\s*(.+)$/);
    if (scopeMatch && !cur.hasScope) {
      cur.hasScope = true;
      cur.scopeText = scopeMatch[1].trim();
    }
  }
  if (cur) categories.push(cur);

  const missing = categories
    .filter((c) => !c.hasScope)
    .map((c) => ({ id: c.id, title: c.title, line: c.line }));
  return { categories, missing };
}

/* ────────────────────────── Anti-pattern self-audit ───────────────────────── */

/**
 * Apply the F3 anti-pattern registry against doctor's own source files and
 * surface every hit. For markdown, only fenced code blocks are scanned —
 * inline backtick references and prose are documentation, not violations.
 * For .mjs files, the entire content is scanned.
 *
 * @param {string} pluginRoot
 * @param {{ registryPath?: string }} [opts]
 * @returns {Array<{ id, severity, file, line, snippet }>}
 */
export function auditDoctorSelf(pluginRoot, opts = {}) {
  const registryPath = opts.registryPath
    ?? join(pluginRoot, 'commands', 'references', 'anti-patterns.md');
  if (!existsSync(registryPath)) return [];

  let registry;
  try { registry = loadRegistry(registryPath); }
  catch { return []; }

  const sources = enumerateDoctorSources(pluginRoot);
  const allHits = [];
  for (const rel of sources) {
    const abs = join(pluginRoot, rel);
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    const scanContext = rel.endsWith('.md') ? stripMarkdownProse(content) : content;
    const hits = scanContent(scanContext, registry.patterns);
    for (const h of hits) {
      allHits.push({ ...h, file: rel });
    }
  }
  return allHits;
}

/* ────────────────────────── Inverse audit ─────────────────────────────────── */

/**
 * Anti-pattern hits in directories OUTSIDE F3's standard scope. F3's PostToolUse
 * hook filters by the registry's `Scope` extension allowlist — markdown files
 * and arbitrary scripts/ entries are skipped at runtime. This is correct for
 * the live edit hook, but a periodic audit (doctor) should still inspect
 * scripts/, agents/, commands/ for the same anti-patterns; otherwise scope
 * leakage (R-DOCTOR-SCOPE-LEAK) hides violations there indefinitely.
 *
 * Output: per-file hit list scoped to the inverse directories.
 */
const INVERSE_AUDIT_DIRS = ['scripts', 'agents', 'commands'];

function walkSource(absDir, exts) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(absDir)) return out;
  const stack = [absDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const child = join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        stack.push(child);
      } else if (e.isFile()) {
        if (exts.has(extname(e.name))) out.push(child);
      }
    }
  }
  return out;
}

export function inverseAudit(pluginRoot, opts = {}) {
  const registryPath = opts.registryPath
    ?? join(pluginRoot, 'commands', 'references', 'anti-patterns.md');
  if (!existsSync(registryPath)) return [];
  let registry;
  try { registry = loadRegistry(registryPath); }
  catch { return []; }

  // Single source for which extensions count as code: F3 registry's own
  // `Scope` allowlist. Keeps the inverse audit in lockstep with F3's runtime
  // scope when the registry adds languages (Rust / Go / Java / Swift / SQL /
  // ...). Without this we previously hard-coded a 6-ext subset that missed
  // anything beyond the JS/TS/Python/shell core — false negatives in
  // multi-language codebases.
  const auditExts = registry.scope?.allowed ?? new Set(['.mjs', '.ts', '.py', '.sh']);
  const out = [];
  for (const dir of INVERSE_AUDIT_DIRS) {
    const absDir = join(pluginRoot, dir);
    const files = walkSource(absDir, auditExts);
    for (const abs of files) {
      let content;
      try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
      const hits = scanContent(content, registry.patterns);
      const rel = relative(pluginRoot, abs);
      for (const h of hits) {
        out.push({ ...h, file: rel });
      }
    }
  }
  return out;
}

/* ────────────────────────── Aggregator ───────────────────────────────────── */

/**
 * Run all four sub-checks. Used by the CLI wrapper and by tests.
 */
export function runMetaSelf(pluginRoot, opts = {}) {
  const sources = enumerateDoctorSources(pluginRoot);
  return {
    plugin_root: pluginRoot,
    doctor_sources: sources,
    self_exemption_hits: detectSelfExemption(pluginRoot, sources),
    anti_pattern_hits: auditDoctorSelf(pluginRoot, opts),
    scope_manifest: validateScopeManifest(pluginRoot),
    inverse_audit_hits: inverseAudit(pluginRoot, opts),
  };
}
