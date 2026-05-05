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

const ARTIFACTS = [
  {
    artifact: 'decomposition',
    pathMatch: (relPath) => /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(relPath),
    parser: 'yaml',
    required: ['phase_id', 'impact_scope', 'success_criteria', 'covers', 'interface_contract'],
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
 * - `markdown` → match a heading (`## key`, `### key`, etc.) or a
 *   `**key**:` style label. Case-insensitive. Underscores and spaces
 *   are interchangeable so `## next_phase_context` and
 *   `## Next Phase Context` both count.
 * - `yaml` → match `key:` at line start (any indentation), or
 *   `- key:` for list-of-objects shapes (decomposition.yaml's phase
 *   entries are list elements).
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
 */
export function validateAgainstSchema(content, schema) {
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
  return {
    valid: missing.length === 0 && missingAnyOf.length === 0,
    missing,
    missingAnyOf,
  };
}

/**
 * One-shot helper: match path → validate → return verdict object.
 * Returns `null` when the path is out of scope.
 */
export function validateArtifactFile(relPath, content) {
  const schema = matchArtifactSchema(relPath);
  if (!schema) return null;
  const { valid, missing, missingAnyOf } = validateAgainstSchema(content, schema);
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
