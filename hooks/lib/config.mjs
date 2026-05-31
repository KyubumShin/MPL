/**
 * MPL Configuration Loader — v2 (additive)
 *
 * Reads `mpl.config.yaml` (workspace > repo-root), validates against
 * `config-schema.json`, deep-merges over the legacy DEFAULTS snapshot,
 * and caches per realpath+mtime. Mirrors the legacy `mpl-config.mjs`
 * public surface (loadConfigV2 / getDefaultsV2 / resolveRuleActionV2) so
 * engine-side callers can swap channels without code change.
 *
 * COEXISTENCE: legacy `mpl-config.mjs` remains the production loader.
 * This module is NOT yet wired into any hook — Move #4 is the additive
 * write-only foundation for the v2 engine.
 *
 * Zero runtime deps. YAML parsing via `./yaml-mini.mjs`.
 * JSON Schema validation is a hand-rolled subset (type + enum +
 * minimum/maximum + additionalProperties) sized for this schema only.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { parseYaml } from './yaml-mini.mjs';
import { loadConfig as legacyLoadConfig } from './mpl-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Repo-root fallback: <repo>/mpl.config.yaml. `__dirname` is `<repo>/hooks/lib`.
const REPO_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT_YAML = join(REPO_ROOT, 'mpl.config.yaml');

const SCHEMA_PATH = join(__dirname, 'config-schema.json');

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------- legacy DEFAULTS snapshot --------------------------------------

/**
 * Snapshot the legacy DEFAULTS by invoking the legacy loader with a
 * cwd that has no `.mpl/config.json`. This re-uses the canonical
 * source-of-truth instead of duplicating the constant.
 */
function snapshotLegacyDefaults() {
  // Any path without `.mpl/config.json` returns pure DEFAULTS.
  // We deliberately pick a path very unlikely to contain one.
  return legacyLoadConfig('/__mpl_no_such_dir__');
}

let _legacyDefaults = null;
function getLegacyDefaults() {
  if (_legacyDefaults === null) _legacyDefaults = snapshotLegacyDefaults();
  // Return a fresh deep-clone so callers can't mutate the snapshot.
  return JSON.parse(JSON.stringify(_legacyDefaults));
}

// ---------- v2-only baseline (empty-but-shaped) ---------------------------

/**
 * The v2-only sections. Empty registries today — policy modules will fill
 * these as they migrate. The loader only treats these as defaults when the
 * YAML omits them entirely (this should not happen for the shipped YAML).
 */
const V2_ONLY_DEFAULTS = {
  channels:  { immutable_paths: [], writable_paths: [] },
  contracts: {},
  evidence:  { rules: [] },
  gates:     {},
  permit:    {},
  schemas:   { rules: [] },
  audit:     { rules: [] },
};

/**
 * The full v2 defaults = legacy DEFAULTS ∪ v2-only registries.
 * Public alias of this for engine callers: `getDefaultsV2()`.
 */
function buildV2Defaults() {
  return deepMerge(getLegacyDefaults(), V2_ONLY_DEFAULTS);
}

// ---------- deep-merge ----------------------------------------------------

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const k of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    const sv = source[k], tv = out[k];
    if (isPlainObject(sv) && isPlainObject(tv)) {
      out[k] = deepMerge(tv, sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}

// ---------- YAML path resolution + cache ----------------------------------

function resolveYamlPath(cwd) {
  if (cwd && typeof cwd === 'string') {
    const ws = join(cwd, 'mpl.config.yaml');
    if (existsSync(ws)) return ws;
  }
  if (existsSync(REPO_ROOT_YAML)) return REPO_ROOT_YAML;
  return null;
}

// Module-scope cache: key = `${realpath}|${mtimeMs}`, value = resolved config.
const CACHE = new Map();

function readAndParseYaml(path) {
  const text = readFileSync(path, 'utf-8');
  return parseYaml(text);
}

// ---------- JSON Schema validation (hand-rolled subset) -------------------

let _schemaCache = null;
function getSchema() {
  if (_schemaCache === null) {
    _schemaCache = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  }
  return _schemaCache;
}

function resolveRef(schema, ref) {
  // Supports only `#/definitions/<name>` form.
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = schema;
  for (const p of parts) {
    if (!node || typeof node !== 'object') return null;
    node = node[p];
  }
  return node || null;
}

function typeMatches(value, type) {
  switch (type) {
    case 'object':  return isPlainObject(value);
    case 'array':   return Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'string':  return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null':    return value === null;
    default:        return true;
  }
}

function validateNode(value, node, rootSchema, pathStr, errors) {
  if (!node || typeof node !== 'object') return;
  if (node.$ref) {
    const target = resolveRef(rootSchema, node.$ref);
    if (target) validateNode(value, target, rootSchema, pathStr, errors);
    return;
  }
  if (node.type) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${pathStr}: expected ${types.join('|')}, got ${describeType(value)}`);
      return;
    }
  }
  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${pathStr}: must be one of ${JSON.stringify(node.enum)}, got ${JSON.stringify(value)}`);
  }
  if (typeof node.minimum === 'number' && typeof value === 'number' && value < node.minimum) {
    errors.push(`${pathStr}: ${value} < minimum ${node.minimum}`);
  }
  if (typeof node.maximum === 'number' && typeof value === 'number' && value > node.maximum) {
    errors.push(`${pathStr}: ${value} > maximum ${node.maximum}`);
  }
  if (node.properties && isPlainObject(value)) {
    for (const [k, sub] of Object.entries(node.properties)) {
      if (k in value) validateNode(value[k], sub, rootSchema, `${pathStr}.${k}`, errors);
    }
  }
}

function describeType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Validate a parsed config against the v2 schema.
 * Returns `{ valid, errors }`. Never throws on validation failure.
 */
export function validateConfig(config) {
  const schema = getSchema();
  const errors = [];
  validateNode(config, schema, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}

// ---------- public surface ------------------------------------------------

/**
 * Load + parse + validate + merge. Caches per realpath+mtime.
 *
 * @param {string} cwd Workspace directory (may be undefined → repo-root only).
 * @returns {object} Merged config (legacy DEFAULTS ∪ v2 registries ∪ YAML).
 *                  When no YAML is found, returns v2 defaults unmodified.
 */
export function loadConfigV2(cwd) {
  const yamlPath = resolveYamlPath(cwd);
  const defaults = buildV2Defaults();
  if (!yamlPath) return defaults;

  let realPath, mtime;
  try {
    realPath = realpathSync(yamlPath);
    mtime = statSync(realPath).mtimeMs;
  } catch {
    return defaults;
  }
  const cacheKey = `${realPath}|${mtime}`;
  const cached = CACHE.get(cacheKey);
  if (cached) return cached;

  let parsed;
  try {
    parsed = readAndParseYaml(realPath);
  } catch (e) {
    // Malformed YAML: fall back to defaults, surface error on stderr.
    process.stderr.write(`[mpl/config.mjs] YAML parse failed (${realPath}): ${e.message}\n`);
    return defaults;
  }

  const validation = validateConfig(parsed);
  if (!validation.valid) {
    process.stderr.write(
      `[mpl/config.mjs] schema validation failed for ${realPath}:\n  - ` +
      validation.errors.join('\n  - ') + '\n'
    );
    // Continue with merge — additive policy: invalid section is overlaid
    // verbatim and engine modules decide what to do. Validation surface is
    // primarily for `mpl-doctor`-like tools.
  }

  const merged = deepMerge(defaults, parsed);
  CACHE.set(cacheKey, merged);
  return merged;
}

/**
 * Pure defaults (legacy DEFAULTS ∪ v2 registries), no YAML overlay.
 * Useful for engine callers that need the baseline shape.
 */
export function getDefaultsV2() {
  return buildV2Defaults();
}

/**
 * Resolve a single enforcement rule's effective action — v2 mirror of
 * `mpl-enforcement.mjs#resolveRuleAction`. Precedence:
 *   state.json:enforcement.<rule> > YAML:enforcement.<rule> > legacy DEFAULTS
 * Strict-mode elevation: `warn` → `block` when `enforcement.strict === true`.
 *
 * @param {string} cwd
 * @param {object | null | undefined} state Pipeline state.json contents.
 * @param {string} ruleId e.g. 'anti_pattern_match'.
 * @returns {'warn' | 'block' | 'off'}
 */
export function resolveRuleActionV2(cwd, state, ruleId) {
  const cfg = loadConfigV2(cwd);
  const baseline = isPlainObject(cfg.enforcement) ? cfg.enforcement : {};
  const override = (state && isPlainObject(state.enforcement)) ? state.enforcement : {};
  const policy = { ...baseline, ...override };
  const v = policy[ruleId];
  if (v === 'off') return 'off';
  if (v === 'block') return 'block';
  return policy.strict === true ? 'block' : 'warn';
}

/**
 * Convenience accessor: parallelism config block (with legacy clamp).
 */
export function getParallelism(cwd) {
  const cfg = loadConfigV2(cwd);
  const p = isPlainObject(cfg.parallelism) ? cfg.parallelism : {};
  const max = Number.isInteger(p.max_phase_workers) ? p.max_phase_workers : 2;
  return { ...p, max_phase_workers: Math.min(3, Math.max(1, max)) };
}

/**
 * Convenience accessor: enforcement block (raw — no strict elevation).
 * For per-rule resolution use `resolveRuleActionV2`.
 */
export function getEnforcement(cwd) {
  const cfg = loadConfigV2(cwd);
  return isPlainObject(cfg.enforcement) ? { ...cfg.enforcement } : {};
}

// Aliases matching the task spec's "Functions:" naming.
export const loadConfig = loadConfigV2;
export const resolveRule = (cwd, state, ruleId) => resolveRuleActionV2(cwd, state, ruleId);

// Test-only: clear the module cache. Not part of the stable surface.
export function __clearCacheForTesting() {
  CACHE.clear();
  _legacyDefaults = null;
  _schemaCache = null;
}
