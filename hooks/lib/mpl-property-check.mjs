/**
 * MPL Property Check (F5, #112)
 *
 * Tier 3 audit — checks whether property declarations in config files are
 * actually consumed by code. Catches the "config-as-decoration" anti-pattern
 * (C2) where exp15 release-gate.mjs declared `expected_tests = 50` but no
 * branch ever read it; the declaration was a comment in the wrong format.
 *
 * Pure functions. Reads the plugin tree, no mutation.
 *
 * Output shape:
 *   {
 *     declarations: Array<{ key: string, value: string|number|boolean, source: { file, line } }>,
 *     unused: Array<{ key: string, source }>,        // declarations with 0 references in code
 *     used: Array<{ key: string, source, references: Array<{file, line}> }>,
 *   }
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';

/**
 * Extensions that count as "code" for the reference grep. Configs themselves
 * are skipped to avoid declaring-and-referencing the same constant table
 * counting as a reference.
 */
const CODE_EXTS = new Set([
  '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx',
  '.py', '.pyw',
  '.rs', '.go', '.java', '.kt', '.scala',
  '.rb', '.php',
  '.sh', '.bash', '.zsh',
]);

const CONFIG_EXTS = new Set(['.json', '.yaml', '.yml', '.toml']);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

/**
 * Extract top-level numeric/boolean/string property declarations from a JSON
 * config file. Nested objects are flattened with dot-notation keys.
 *
 * Non-primitive leaves (arrays, null) are ignored — references to those rarely
 * follow the simple "look for the key name" heuristic and would create noise.
 *
 * @param {string} content - JSON text
 * @param {string} relPath - workspace-relative path of the config file (for source attribution)
 * @returns {Array<{ key: string, value: string|number|boolean, source: { file: string } }>}
 */
export function extractDeclarations(content, relPath = '<inline>') {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const out = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue; // convention: leading underscore = private metadata
      const keyPath = prefix ? `${prefix}.${k}` : k;
      if (v === null) continue;
      if (typeof v === 'object' && !Array.isArray(v)) {
        walk(v, keyPath);
        continue;
      }
      if (Array.isArray(v)) continue;
      if (['number', 'boolean', 'string'].includes(typeof v)) {
        out.push({ key: keyPath, value: v, source: { file: relPath } });
      }
    }
  };
  walk(parsed, '');
  return out;
}

/**
 * Walk a directory tree collecting code-extension files. Skips
 * `node_modules`, `.git`, dist, build, .next, coverage.
 *
 * @param {string} rootDir
 * @returns {string[]} - absolute file paths
 */
function walkCodeFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const child = join(cur, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(child);
      } else if (e.isFile() && CODE_EXTS.has(extname(e.name))) {
        out.push(child);
      }
    }
  }
  return out;
}

/**
 * Files whose presence shouldn't count as a config-key reference. Test files
 * exist precisely because the config exists — counting them would render F5
 * blind to the config-as-decoration pattern (PR #131 review #1). The
 * property-check implementation itself is excluded for the same reason: it
 * mentions arbitrary keys in prose and string examples.
 */
const NON_CONSUMER_FILE_RE = /(?:^|\/)(?:__tests__\/|.+\.(?:test|spec)\.[^/]+|mpl-property-check\.(?:mjs|md))/;

/**
 * Find references to a declaration key inside the code files of `rootDir`.
 * The key is reduced to its trailing dot-segment ('min_tests') and matched by
 * code-shape patterns only:
 *
 *   - member access:  `obj.min_tests`
 *   - subscript:      `obj['min_tests']` / `obj["min_tests"]`
 *   - function arg:   `resolveRuleAction(cwd, state, 'min_tests')`
 *
 * Word-boundary grep alone (PR #131 review #1) is too permissive: it matches
 * unrelated identifiers, prose, comments mentioning the key, import paths
 * like `node:assert/strict`, etc. Code-shape access is what an actual
 * consumer looks like.
 *
 * Test files and the property-check implementation are also excluded — those
 * surfaces mention keys without consuming them.
 *
 * @param {string} rootDir
 * @param {string} key - dot-notation key, e.g. 'gates.min_tests'
 * @param {{ codeFiles?: string[] }} [opts] - precomputed file list (for batch runs)
 * @returns {Array<{ file: string, line: number }>}
 */
export function findReferences(rootDir, key, opts = {}) {
  const leaf = key.split('.').pop();
  if (!leaf) return [];
  const e = escapeRegex(leaf);
  const patterns = [
    new RegExp(`\\.${e}\\b`),                         // member access
    new RegExp(`\\[\\s*['"\`]${e}['"\`]\\s*\\]`),     // subscript
    new RegExp(`\\([^)]*['"\`]${e}['"\`][^)]*\\)`),   // function-arg string literal
  ];
  const refs = [];
  const files = (opts.codeFiles ?? walkCodeFiles(rootDir))
    .filter((abs) => !NON_CONSUMER_FILE_RE.test(relative(rootDir, abs)));
  for (const abs of files) {
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (patterns.some((p) => p.test(lines[i]))) {
        refs.push({ file: relative(rootDir, abs), line: i + 1 });
      }
    }
  }
  return refs;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Run the property check against a single config file.
 *
 * @param {string} rootDir
 * @param {string} configPath - workspace-relative path to the config file
 * @returns {{
 *   configPath: string,
 *   declarations: ReturnType<typeof extractDeclarations>,
 *   used: Array<{ key: string, source: { file: string }, references: Array<{file, line}> }>,
 *   unused: ReturnType<typeof extractDeclarations>,
 * }}
 */
export function runPropertyCheck(rootDir, configPath) {
  const abs = join(rootDir, configPath);
  if (!existsSync(abs)) {
    return { configPath, declarations: [], used: [], unused: [] };
  }
  let content;
  try { content = readFileSync(abs, 'utf-8'); } catch {
    return { configPath, declarations: [], used: [], unused: [] };
  }
  const declarations = extractDeclarations(content, configPath);
  const codeFiles = walkCodeFiles(rootDir);
  const used = [];
  const unused = [];
  for (const decl of declarations) {
    const references = findReferences(rootDir, decl.key, { codeFiles });
    if (references.length > 0) used.push({ ...decl, references });
    else unused.push(decl);
  }
  return { configPath, declarations, used, unused };
}

/**
 * Inverse audit: anti-pattern hits in directories outside F3's runtime scope
 * (handled in F4 / mpl-meta-self.mjs#inverseAudit). F5 just re-exports a thin
 * runner so doctor Category 15 can dispatch property-check + inverse audit
 * from the same CLI without dragging in the meta-self surface.
 *
 * @param {string} rootDir
 * @param {string[]} configPaths
 * @returns {Array<ReturnType<typeof runPropertyCheck>>}
 */
export function runBatch(rootDir, configPaths) {
  return configPaths.map((p) => runPropertyCheck(rootDir, p));
}

/**
 * Helpful flag for the agent: known config locations the doctor surface
 * audits by default. Workspaces can override via CLI args.
 */
export const DEFAULT_CONFIG_TARGETS = [
  '.mpl/config.json',
  'config/enforcement.json',
  'config/verification-tool-paths.json',
];
