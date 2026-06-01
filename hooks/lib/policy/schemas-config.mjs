/**
 * Schemas Config Loader (Move P3 #6 Pass 1).
 *
 * Bridge between the frozen-in-module schema constants in
 * `policy/schemas.mjs` and the declarative `mpl.config.yaml#schemas.rules`
 * registry. When the YAML registry is empty OR a specific rule is malformed,
 * each getter returns the frozen fallback from policy/schemas.mjs so behavior
 * stays byte-identical.
 *
 * Three rules migrated in Pass 1 (no semantic change unless workspace opts
 * in via YAML override):
 *   - pp_uc_leakage         -> UC_SCHEMA_PATTERNS
 *   - agent_output_sections -> VALIDATE_AGENTS + EXPECTED_SECTIONS
 *   - property_audit_targets-> DEFAULT_CONFIG_TARGETS
 *
 * Two rules deferred to Pass 2/3:
 *   - phase_seed_required   -> validateSeed inline control flow (Pass 3)
 *
 * Memoized per cwd realpath. Recompilation on cache miss is best-effort: a
 * malformed regex / shape never throws; the loader silently falls back to
 * the frozen constant.
 */

import { realpathSync } from 'fs';

import { loadConfigV2 } from '../config.mjs';
import {
  UC_SCHEMA_PATTERNS,
  VALIDATE_AGENTS,
  EXPECTED_SECTIONS,
  DEFAULT_CONFIG_TARGETS,
} from './schemas.mjs';

// ----------------------------------------------------------------------------
// Per-cwd memoization. Recompiles only when the cwd realpath differs.
// (loadConfigV2 already memoizes per realpath+mtime — wrapping in another
// per-cwd map avoids re-walking the rules tree on every call.)
// ----------------------------------------------------------------------------
const CACHE = new Map();

function cacheKey(cwd) {
  if (!cwd || typeof cwd !== 'string') return '<process-cwd>';
  try { return realpathSync(cwd); } catch { return cwd; }
}

function getCached(cwd, key) {
  const ck = cacheKey(cwd);
  const bucket = CACHE.get(ck);
  if (!bucket) return undefined;
  return bucket[key];
}

function setCached(cwd, key, value) {
  const ck = cacheKey(cwd);
  let bucket = CACHE.get(ck);
  if (!bucket) {
    bucket = {};
    CACHE.set(ck, bucket);
  }
  bucket[key] = value;
}

function rulesMap(cwd) {
  try {
    const cfg = loadConfigV2(cwd);
    const rules = cfg?.schemas?.rules;
    // Array shape (legacy default) -> no map-style overrides registered.
    if (!rules || Array.isArray(rules) || typeof rules !== 'object') return null;
    return rules;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// (1) pp_uc_leakage -> UC_SCHEMA_PATTERNS
// ----------------------------------------------------------------------------

/**
 * @returns {ReadonlyArray<{re: RegExp, name: string}>}
 */
export function getUcSchemaPatterns(cwd) {
  const cached = getCached(cwd, 'pp_uc_leakage');
  if (cached) return cached;

  const rules = rulesMap(cwd);
  const rule = rules?.pp_uc_leakage;
  if (!rule || rule.kind !== 'regex_denylist' || !Array.isArray(rule.patterns)) {
    setCached(cwd, 'pp_uc_leakage', UC_SCHEMA_PATTERNS);
    return UC_SCHEMA_PATTERNS;
  }

  const compiled = [];
  for (const entry of rule.patterns) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const src = typeof entry.re === 'string' ? entry.re : '';
    if (!name || !src) continue;
    const flags = typeof entry.flags === 'string' ? entry.flags : '';
    let re;
    try {
      re = new RegExp(src, flags);
    } catch {
      // malformed regex — skip silently (per loader contract).
      continue;
    }
    compiled.push(Object.freeze({ re, name }));
  }

  // Empty / fully-malformed config -> fallback so behavior is preserved.
  if (compiled.length === 0) {
    setCached(cwd, 'pp_uc_leakage', UC_SCHEMA_PATTERNS);
    return UC_SCHEMA_PATTERNS;
  }
  const frozen = Object.freeze(compiled);
  setCached(cwd, 'pp_uc_leakage', frozen);
  return frozen;
}

// ----------------------------------------------------------------------------
// (2) agent_output_sections -> VALIDATE_AGENTS + EXPECTED_SECTIONS
// ----------------------------------------------------------------------------

function _agentOutputBundle(cwd) {
  const cached = getCached(cwd, 'agent_output_sections');
  if (cached) return cached;

  const rules = rulesMap(cwd);
  const rule = rules?.agent_output_sections;
  if (!rule || rule.kind !== 'section_presence' || !rule.agents || typeof rule.agents !== 'object') {
    const fallback = { agents: VALIDATE_AGENTS, sections: EXPECTED_SECTIONS };
    setCached(cwd, 'agent_output_sections', fallback);
    return fallback;
  }

  const agentList = [];
  const sections = {};
  for (const [agent, val] of Object.entries(rule.agents)) {
    if (!agent || typeof agent !== 'string') continue;
    if (!Array.isArray(val)) continue;
    const list = val.filter((s) => typeof s === 'string' && s.length > 0);
    if (list.length === 0) continue;
    agentList.push(agent);
    sections[agent] = Object.freeze([...list]);
  }
  if (agentList.length === 0) {
    const fallback = { agents: VALIDATE_AGENTS, sections: EXPECTED_SECTIONS };
    setCached(cwd, 'agent_output_sections', fallback);
    return fallback;
  }
  const bundle = {
    agents: new Set(agentList),
    sections: Object.freeze(sections),
  };
  setCached(cwd, 'agent_output_sections', bundle);
  return bundle;
}

/** @returns {Set<string>} */
export function getValidateAgents(cwd) {
  return _agentOutputBundle(cwd).agents;
}

/** @returns {Readonly<Record<string, ReadonlyArray<string>>>} */
export function getExpectedSections(cwd) {
  return _agentOutputBundle(cwd).sections;
}

// ----------------------------------------------------------------------------
// (3) property_audit_targets -> DEFAULT_CONFIG_TARGETS
// ----------------------------------------------------------------------------

/**
 * @returns {ReadonlyArray<string>} workspace-configured property-audit
 * target list, or the frozen fallback when none provided.
 */
export function getPropertyAuditTargets(cwd) {
  const cached = getCached(cwd, 'property_audit_targets');
  if (cached) return cached;

  const rules = rulesMap(cwd);
  const rule = rules?.property_audit_targets;
  if (!rule || rule.kind !== 'config_target_list' || !Array.isArray(rule.paths)) {
    setCached(cwd, 'property_audit_targets', DEFAULT_CONFIG_TARGETS);
    return DEFAULT_CONFIG_TARGETS;
  }
  const list = rule.paths.filter((p) => typeof p === 'string' && p.length > 0);
  if (list.length === 0) {
    setCached(cwd, 'property_audit_targets', DEFAULT_CONFIG_TARGETS);
    return DEFAULT_CONFIG_TARGETS;
  }
  const frozen = Object.freeze([...list]);
  setCached(cwd, 'property_audit_targets', frozen);
  return frozen;
}

// ----------------------------------------------------------------------------
// (4) phase_seed_required spec — Pass-3 deferred. Returns frozen descriptor
// purely as a forward-compat surface; schemas.mjs#validateSeed currently
// ignores the schema arg.
// ----------------------------------------------------------------------------

/**
 * @returns {{ enabled: boolean, raw: any }} descriptor; `enabled:false`
 * means schemas.mjs#validateSeed keeps using its inline control flow.
 */
export function getPhaseSeedRequiredSpec(cwd) {
  const cached = getCached(cwd, 'phase_seed_required');
  if (cached) return cached;

  const rules = rulesMap(cwd);
  const rule = rules?.phase_seed_required;
  const spec = rule && typeof rule === 'object' && rule.enabled === true
    ? Object.freeze({ enabled: true, raw: rule })
    : Object.freeze({ enabled: false, raw: rule || null });
  setCached(cwd, 'phase_seed_required', spec);
  return spec;
}

// ----------------------------------------------------------------------------
// Test helper — clears the per-cwd cache. Production code never calls this.
// ----------------------------------------------------------------------------
export function __clearSchemasConfigCacheForTesting() {
  CACHE.clear();
}
