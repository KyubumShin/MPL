/**
 * Artifact schema validator (P0-K / #115).
 *
 * Pre-P0-K, the orchestrator and phase-runner emitted artifacts whose
 * required sections were enforced only by prose ("each state-summary
 * MUST include status, files_changed, verification, decisions,
 * next_phase_context"). Real runs occasionally produced artifacts
 * missing one or more sections — surfaced only when a downstream
 * reader (mpl-adversarial-reviewer, finalize, gate-recorder) tripped
 * on the missing field, often phases later. R-MISSING-ARTIFACT-SCHEMA
 * (Evidence A) showed exp15 phase-9 state-summary lacked
 * `next_phase_context`, and the next phase had to reverse-engineer it
 * from git diff.
 *
 * P0-K moves the contract into a hook (`hooks/mpl-artifact-schema.mjs`,
 * PostToolUse Edit|Write|MultiEdit) backed by this lib. Each artifact
 * has a path matcher and a required-section list. A heading-style
 * presence check is enough for markdown artifacts (orchestrator and
 * agent prompts already write `## Status` / `## Files Changed` /
 * etc.); YAML artifacts use top-level key presence.
 *
 * Action policy comes from
 * `enforcement.missing_artifact_schema` (P0-2 / #110):
 *   - `warn` (default) → surface missing sections as a system-reminder.
 *   - `block` → exit-2 with the reason; the orchestrator must
 *     re-emit before the write goes through.
 *   - `off` → log to `.mpl/signals/artifact-schema-hits.jsonl` only.
 *
 * Pure functions. The hook handles I/O / signal emission.
 */

import { loadConfig } from './mpl-config.mjs';

const ARTIFACTS = [
  {
    artifact: 'goal-contract',
    pathMatch: (relPath) => /(^|\/)\.mpl\/goal-contract\.ya?ml$/.test(relPath),
    parser: 'yaml',
    required: [
      'source',
      'mission',
      'goal',
      'project_pivot',
      'ontology',
      'variation_axes',
      'acceptance_criteria',
      'e2e_policy',
      'security_policy',
      'completion_evidence',
    ],
  },
  {
    artifact: 'decomposition',
    pathMatch: (relPath) => /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(relPath),
    parser: 'yaml',
    // PR #135 review #1 (Codex HIGH): keys must match the actual
    // decomposer output (`agents/mpl-decomposer.md` <Output_Schema>):
    // `id` (not `phase_id`), `scope` + `impact` (not `impact_scope`),
    // `covers`, `interface_contract`, `success_criteria`. The earlier
    // schema rejected every valid decomposition.yaml.
    required: ['id', 'scope', 'impact', 'covers', 'interface_contract', 'success_criteria'],
    customValidate: validateDecompositionContract,
  },
  {
    artifact: 'state-summary',
    pathMatch: (relPath) => /(^|\/)\.mpl\/mpl\/phases\/phase-[\w.-]+\/state-summary\.md$/.test(relPath),
    parser: 'markdown',
    required: ['status', 'files_changed', 'verification', 'decisions', 'next_phase_context'],
  },
  {
    artifact: 'verification',
    pathMatch: (relPath) => /(^|\/)\.mpl\/mpl\/phases\/phase-[\w.-]+\/verification\.md$/.test(relPath),
    parser: 'markdown',
    // The spec lists `command|file|grep` and `result|exit_code` as
    // "evidence + result" pairs. We accept either side of each pair as
    // satisfying the requirement (verification artifacts vary in shape
    // depending on whether the gate ran a command, grep, or static
    // file check).
    required: ['criterion', 'evidence_type'],
    requiredAnyOf: [
      ['command', 'file', 'grep'],
      ['result', 'exit_code'],
    ],
  },
  {
    artifact: 'pivot-points',
    pathMatch: (relPath) => /(^|\/)\.mpl\/pivot-points\.md$/.test(relPath),
    parser: 'markdown',
    required: ['PP_id', 'constraint', 'status', 'source'],
  },
  {
    artifact: 'user-contract',
    pathMatch: (relPath) => /(^|\/)\.mpl\/requirements\/user-contract\.md$/.test(relPath),
    parser: 'markdown',
    // The issue spec says "scenario coverage" (with a space). Treat
    // either `scenario_coverage` (snake_case section heading) or
    // `scenario coverage` (literal phrase) as satisfying the
    // requirement so a writer who picks one form isn't blocked.
    required: ['UC_id', 'status'],
    requiredAnyOf: [
      ['scenario_coverage', 'scenario coverage'],
    ],
  },
];

/**
 * Find the schema definition that matches `relPath`. Path is workspace-
 * relative (e.g. `.mpl/mpl/decomposition.yaml`). Returns null when no
 * schema applies — caller should treat that as "out of scope".
 */
export function matchArtifactSchema(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  return ARTIFACTS.find((s) => s.pathMatch(relPath)) ?? null;
}

/**
 * Test the presence of `key` in `content` per the schema's parser kind.
 *
 * - `markdown` → match a heading (`## key`, `### key`, etc.), a
 *   `**key**:` bold label, OR a `key: value` line (presence-only;
 *   the line could be a single-line stub — see "Known limitations"
 *   below). Case-insensitive. Underscores and spaces are
 *   interchangeable so `## next_phase_context` and
 *   `## Next Phase Context` both count.
 * - `yaml` → match `key:` at line start (any indentation), or
 *   `- key:` for list-of-objects shapes (decomposition.yaml's phase
 *   entries are list elements).
 *
 * **Known limitations** (PR #135 review notes — accepted trade-offs):
 *   1. **Stub tolerance** (markdown): the `key: value` branch matches
 *      one-line stubs, not just full sections. Schema validity ≠
 *      content quality. The hook's job is to catch missing sections,
 *      not police section depth — section-content review is the
 *      adversarial reviewer's (P0-A / #103) responsibility.
 *   2. **Global presence** (yaml): for list-of-objects artifacts like
 *      `decomposition.yaml`, presence anywhere in the document
 *      satisfies the check. Per-list-element coverage requires a real
 *      YAML parser; tracked as a follow-up. Today, a key that any
 *      single phase carries counts as "present" even when a different
 *      phase omits it. `mpl-require-covers.mjs` covers the most
 *      important field (`covers`) per-phase already.
 */
export function hasKey(content, key, parser) {
  if (typeof content !== 'string' || typeof key !== 'string') return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Allow underscore ↔ space ↔ dash interchange so heading style
  // variations don't trip the check.
  const flexible = escaped.replace(/[_\s-]/g, '[_\\s-]');

  if (parser === 'yaml') {
    const re = new RegExp(`^\\s*-?\\s*${flexible}\\s*:`, 'mi');
    return re.test(content);
  }

  // markdown: heading OR bold label OR YAML-ish front-matter line.
  const re = new RegExp(
    `(?:^#+\\s*${flexible}\\b)` +    // ## key
    `|(?:\\*\\*${flexible}\\*\\*)` + // **key**
    `|(?:^\\s*${flexible}\\s*:)`,    // key:
    'mi'
  );
  return re.test(content);
}

/**
 * Validate `content` against `schema`. Returns
 * `{ valid, missing, missingAnyOf }` — `missing` lists individual
 * required keys that weren't found; `missingAnyOf` lists groups where
 * none of the alternatives matched.
 *
 * #240 + codex/claude r3 on PR #244: when the caller provides cwd in
 * opts, it's threaded into customValidate so schema-level checks can
 * honor workspace config knobs (e.g. test_agent.default_required).
 */
export function validateAgainstSchema(content, schema, opts = {}) {
  if (!schema) return { valid: true, missing: [], missingAnyOf: [] };
  const missing = [];
  for (const key of schema.required ?? []) {
    if (!hasKey(content, key, schema.parser)) missing.push(key);
  }
  const missingAnyOf = [];
  for (const group of schema.requiredAnyOf ?? []) {
    if (!group.some((alt) => hasKey(content, alt, schema.parser))) {
      missingAnyOf.push(group);
    }
  }
  if (typeof schema.customValidate === 'function') {
    const custom = schema.customValidate(content, opts);
    missing.push(...(custom.missing ?? []));
    missingAnyOf.push(...(custom.missingAnyOf ?? []));
  }
  return {
    valid: missing.length === 0 && missingAnyOf.length === 0,
    missing,
    missingAnyOf,
  };
}

function parseDecompositionPhases(content) {
  const phases = [];
  let cur = null;

  for (const rawLine of String(content || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const idMatch = line.match(/^\s*-\s+id:\s*["']?([^"'\s#]+)["']?/);
    if (idMatch) {
      if (cur) phases.push(cur);
      cur = {
        id: idMatch[1],
        hasTestAgentRequired: false,
        hasTestAgentRationale: false,
        testAgentRequired: null,
      };
      continue;
    }
    if (!cur) continue;

    const reqMatch = line.match(/^\s+test_agent_required\s*:\s*(true|false)\b/i);
    if (reqMatch) {
      cur.hasTestAgentRequired = true;
      cur.testAgentRequired = reqMatch[1].toLowerCase() === 'true';
      continue;
    }

    if (/^\s+test_agent_rationale\s*:/.test(line)) {
      cur.hasTestAgentRationale = true;
    }
  }

  if (cur) phases.push(cur);
  return phases;
}

function validateDecompositionContract(content, opts = {}) {
  // #240 A2 + codex/claude r3 on PR #244 [contract-break]: when the
  // workspace explicitly opted out of "absence is required" via
  // `test_agent.default_required: false`, hand-written / legacy
  // decompositions that omit `test_agent_required` per phase must
  // NOT trip the artifact schema. Explicit `test_agent_required:
  // false` still requires a rationale per AD-0007.
  let defaultRequired = true;
  if (opts.cwd) {
    try {
      const cfg = loadConfig(opts.cwd);
      if (cfg?.test_agent?.default_required === false) defaultRequired = false;
    } catch { /* fall back to strict default on read error */ }
  }
  const missing = [];
  for (const phase of parseDecompositionPhases(content)) {
    if (!phase.hasTestAgentRequired && defaultRequired) {
      missing.push(`${phase.id}.test_agent_required`);
    }
    if (phase.testAgentRequired === false && !phase.hasTestAgentRationale) {
      missing.push(`${phase.id}.test_agent_rationale`);
    }
  }
  return { missing, missingAnyOf: [] };
}

/**
 * One-shot helper: match path → validate → return verdict object.
 * Returns `null` when the path is out of scope.
 */
export function validateArtifactFile(relPath, content, opts = {}) {
  const schema = matchArtifactSchema(relPath);
  if (!schema) return null;
  const { valid, missing, missingAnyOf } = validateAgainstSchema(content, schema, opts);
  return {
    artifact: schema.artifact,
    relPath,
    valid,
    missing,
    missingAnyOf,
  };
}

/**
 * List of artifact-schema definitions. Exposed for tests and for
 * doctor/finalize re-checks that want to walk all known artifacts.
 */
export const ARTIFACT_SCHEMAS = Object.freeze(
  ARTIFACTS.map((s) => Object.freeze({ ...s }))
);
