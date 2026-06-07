/**
 * MPL Codex Auditor (F6, #117) — Tier 4 last-mile audit.
 *
 * Tier 1+2+3 (F2 hook scan, F3 anti-pattern registry, F5 property check)
 * catch ~7/8 of MPL-spec violations during execution. F6 is the
 * finalize-time sweep that catches the last 1/8 by cross-referencing
 * intent (decomposition.yaml + user-contract.md) against implementation
 * (declared impact files + git changes).
 *
 * Three audit surfaces — each one mechanically derived; no LLM call here.
 * The agent prompt (`agents/mpl-codex-auditor.md`) wraps this CLI for
 * orchestrator dispatch; raw findings are emitted as `audit-report.json`
 * at `.mpl/mpl/audit-report.json` and surfaced to the user.
 *
 *   1. anti_pattern_residual — re-scan files declared in decomposition.yaml
 *      (create + modify) using the F3 anti-pattern registry. Tier 1+2+3
 *      caught most at write-time; this surface lists what survived.
 *
 *   2. missing_covers — every `included` UC in user-contract.md must be
 *      covered by at least one phase. Phases that claim `covers: [UC-N]`
 *      must reference UCs that actually exist as included.
 *
 *   3. drift — declared phase impact (create + modify paths) vs git
 *      changed files. `undeclared` are files touched but not in any
 *      phase scope; `unimplemented` are declared paths with no diff
 *      footprint. Mirrors Step 5.1.5's informational drift report but
 *      collapsed into the audit-report verdict surface.
 *
 * Verdict policy (mirrors P0-2 enforcement style):
 *   - `pass` — no anti-pattern hits AND no missing covers
 *   - `fail` — any of the above non-empty
 *   - drift surface is informational only (matches 5.1.5 contract)
 *
 * Pure functions. CLI handles I/O, exit codes, and signal logging.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';

import { loadRegistry, scanContent, isInScope } from './anti-pattern-registry.mjs';

/* ────────────────────────── User contract parsing ────────────────────────── */

/**
 * Legacy graceful-skip mode signal. Mirrors `mpl-require-covers.mjs#isLegacyMode`
 * verbatim — file absence is the canonical signal that the project predates
 * 0.16 Tier B and never produced a UC contract.
 *
 * Note: this is one of TWO graceful-skip signals (see `runCodexAudit`). File-
 * absent is mode `legacy_skip`; file-present with empty `user_cases:` (Phase
 * 0's graceful-skip output for legacy projects per `commands/mpl-run-phase0.md`
 * line 228, `Skip condition: Legacy projects (pre-0.16) ... write graceful-skip
 * user-contract.md with user_cases: []`) is mode `empty_skip`. Both suppress
 * `findMissingCovers` surfaces.
 *
 * PR #136 review (Codex HIGH + follow-up) fix: pre-fix, every non-`internal`
 * phase cover was reported as dangling when no UC was included (whether due
 * to file absence OR Phase 0's explicit empty-list graceful skip). That
 * contradicted the require-covers contract and could halt finalize under
 * `enforcement.audit_residual = 'block'` or strict mode for a legitimately-
 * graceful pipeline.
 */
export function isLegacyContractMode(cwd) {
  return !existsSync(join(cwd, '.mpl/requirements/user-contract.md'));
}

/**
 * Extract every `included` UC id from `.mpl/requirements/user-contract.md`.
 * The file is YAML embedded inside a markdown wrapper; we use a regex pass
 * keyed on `id: "UC-NN"` lines under the `user_cases:` block. The
 * graceful-skip mode (file absent → empty user_cases) is tolerated by
 * returning an empty array — caller must combine with `isLegacyContractMode`
 * to distinguish "no contract" from "empty contract" semantics.
 *
 * Returns `[{ id, title }]`. `title` is best-effort (next non-empty
 * line containing `title:`) — used only for human-readable surface.
 */
export function enumerateIncludedUserCases(cwd) {
  const path = join(cwd, '.mpl/requirements/user-contract.md');
  if (!existsSync(path)) return [];

  let content;
  try { content = readFileSync(path, 'utf-8'); }
  catch { return []; }

  // Locate the `user_cases:` section. Stop at the next top-level YAML key
  // (`deferred_cases:`, `cut_cases:`, `scenarios:`, `pp_conflict_log:`,
  // `ambiguity_hints:`) so deferred/cut UCs are not treated as included.
  // We walk lines to avoid the off-by-one risk of slice(1)+search/m: that
  // pattern matches the leftover `ser_cases:` substring on the very next
  // character of the slice, terminating the block before any UC is read.
  // PR #136 review #3 (Claude 🟡): allow indented `user_cases:` so an author
  // who places the YAML inside an indented markdown fence still parses.
  const lines = content.split('\n');
  const startIdx = lines.findIndex(l => /^\s*user_cases\s*:/.test(l));
  if (startIdx < 0) return [];

  // Capture the indent of `user_cases:` so the section-end check stops on a
  // sibling key at the SAME level rather than any column-0 key.
  const sectionIndent = (lines[startIdx].match(/^(\s*)/) ?? ['', ''])[1].length;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const indentMatch = line.match(/^(\s*)([a-z_]+)\s*:\s*$/);
    if (indentMatch && indentMatch[1].length === sectionIndent) {
      endIdx = i; break;
    }
    // Closing fence ends the YAML block too.
    if (/^\s*```/.test(line)) { endIdx = i; break; }
  }
  const userCasesBlock = lines.slice(startIdx, endIdx).join('\n');

  const cases = [];
  // Each UC begins with `- id: "UC-NN"`. We walk those entries and
  // capture title + status. Only `status: included` (or status absent
  // because the included section's bullets sometimes omit the explicit
  // line — schema says "이 섹션은 included만") survives.
  const ucBlocks = userCasesBlock.split(/^\s*-\s+id\s*:\s*/m).slice(1);
  for (const block of ucBlocks) {
    const idMatch = block.match(/^["']?(UC-[\w-]+)["']?/);
    if (!idMatch) continue;
    const id = idMatch[1];

    // Hard-stop at the next bullet boundary (next `- id:` was already
    // consumed by the split, but a stray `- ` for steps inside should
    // not bleed).  Title and status only need to match within the same
    // bullet body.
    const titleMatch = block.match(/^\s*title\s*:\s*["']?([^"'\n]+)["']?/m);
    const statusMatch = block.match(/^\s*status\s*:\s*["']?([\w-]+)["']?/m);
    const status = statusMatch ? statusMatch[1] : 'included';
    if (status !== 'included') continue;

    cases.push({
      id,
      title: titleMatch ? titleMatch[1].trim() : '',
    });
  }

  return cases;
}

/* ────────────────────────── Decomposition parsing ────────────────────────── */

/**
 * Parse decomposition.yaml into `[{ id, covers, impact_files }]` where
 * `impact_files` is the union of `create` + `modify` paths (excluding
 * `affected_tests` and `affected_config` — those are downstream artifacts
 * and don't represent intent-bearing scope for the drift comparison).
 *
 * Reuses the regex parsing approach from `mpl-decomposition-parser.mjs`
 * (no YAML dependency). Differs in that it preserves the section-of-origin
 * for each path and includes the `covers` array.
 */
export function parseDecompositionPhases(cwd) {
  const path = join(cwd, '.mpl/mpl/decomposition.yaml');
  if (!existsSync(path)) return [];

  let content;
  try { content = readFileSync(path, 'utf-8'); }
  catch { return []; }

  // PR #136 review #2 (Claude 🟡): allow any indent depth for the phase
  // entry. Pre-fix `^  - id:\s*` (exact 2-space) silent-broke when the
  // decomposer wraps `phases:` deeper (future task/meta layer) — every
  // phase block was missed and the audit returned `phases: []` quietly.
  const phases = [];
  const blocks = content.split(/^\s*-\s+id\s*:\s*/m).slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    const id = lines[0]?.replace(/["']/g, '').trim();
    if (!id) continue;

    const covers = parseCoversArray(block);
    const impact = parseImpactFiles(block);

    phases.push({ id, covers, impact_files: impact });
  }

  return phases;
}

function parseCoversArray(block) {
  // Match `covers: [UC-01, UC-02]` (inline) OR
  //   covers:
  //     - "UC-01"
  //     - "UC-02"
  // Inline form check first so YAML-list form below doesn't re-capture.
  const inline = block.match(/^\s*covers\s*:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1]
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  const out = [];
  const lines = block.split('\n');
  let inCovers = false;
  for (const line of lines) {
    if (/^\s*covers\s*:\s*$/.test(line)) { inCovers = true; continue; }
    if (!inCovers) continue;
    const item = line.match(/^\s*-\s*["']?([\w-]+)["']?\s*$/);
    if (item) { out.push(item[1]); continue; }
    // Any non-list line ends the covers section.
    if (/^\s*[a-z_]+\s*:/.test(line)) break;
  }
  return out;
}

function parseImpactFiles(block) {
  // Walk `impact:` subsections create/modify only (intent-bearing scope).
  // PR #136 review #1 (Claude 🟡): use indent-tolerant matching with the
  // captured leading whitespace as the section's anchor depth, then accept
  // any deeper indent for the bullet entries. Pre-fix `\s{4,6}` literal
  // silent-broke if the decomposer ever wraps `phases:` in a meta layer.
  const lines = block.split('\n');
  const files = new Set();
  let activeSection = null;   // 'create' | 'modify' | null
  let sectionIndent = -1;     // column where active section's key starts
  for (const line of lines) {
    const sectionMatch = line.match(/^(\s+)(create|modify|affected_tests|affected_config)\s*:\s*$/);
    if (sectionMatch) {
      const isImpactKey = (sectionMatch[2] === 'create' || sectionMatch[2] === 'modify');
      activeSection = isImpactKey ? sectionMatch[2] : null;
      sectionIndent = sectionMatch[1].length;
      continue;
    }
    if (!activeSection) continue;
    // Stop when we hit another sibling key at SAME indent (e.g. `interface_contract:`).
    const siblingMatch = line.match(/^(\s+)[a-z_]+\s*:\s*$/);
    if (siblingMatch && siblingMatch[1].length === sectionIndent) {
      activeSection = null;
      sectionIndent = -1;
      continue;
    }
    const pathInline = line.match(/^\s+-\s+path\s*:\s*["']?([^"'\n]+)["']?/);
    if (pathInline) { files.add(pathInline[1].trim()); continue; }
    const pathBare = line.match(/^\s+-\s+["']?([^"'\n#]+\.[\w]+)["']?\s*$/);
    if (pathBare) { files.add(pathBare[1].trim()); continue; }
  }
  return [...files];
}

/* ────────────────────────── Surface 1: anti-pattern residual ─────────────── */

/**
 * Scan declared phase impact files against the F3 registry. Files that
 * don't exist on disk (e.g. phase planned but not yet implemented) are
 * skipped silently — they will surface as `drift.unimplemented` instead.
 *
 * Returns `[{ phase_id, file, id (pattern), severity, line, snippet }]`.
 */
export function auditAntiPatternResidual(cwd, pluginRoot, phases) {
  const registryPath = join(pluginRoot, 'commands', 'references', 'anti-patterns.md');
  if (!existsSync(registryPath)) return [];

  let registry;
  try { registry = loadRegistry(registryPath); }
  catch { return []; }

  const hits = [];
  const seen = new Set();
  for (const phase of phases) {
    for (const rel of phase.impact_files) {
      const key = `${phase.id} ${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Anti-pattern registry has explicit scope (file extension allowlist
      // + agent/registry self-exclusion). Defer to it — keeps audit
      // consistent with how Tier 1 hook decides scope.
      if (!isInScope(rel, registry.scope)) continue;

      const abs = join(cwd, rel);
      if (!existsSync(abs)) continue;
      try {
        const stat = statSync(abs);
        if (!stat.isFile()) continue;
      } catch { continue; }

      let content;
      try { content = readFileSync(abs, 'utf-8'); }
      catch { continue; }

      const fileHits = scanContent(content, registry.patterns);
      for (const h of fileHits) {
        hits.push({
          phase_id: phase.id,
          file: rel,
          id: h.id,
          severity: h.severity,
          line: h.line,
          snippet: h.snippet,
        });
      }
    }
  }
  return hits;
}

/* ────────────────────────── Surface 2: missing covers ────────────────────── */

/**
 * Cross-check user-contract.md included UCs against decomposition phases.
 *
 * Two failure modes:
 *   - `uncovered` — included UC that no phase claims
 *   - `dangling`  — phase claims `covers: [UC-N]` but UC-N is not included
 *                   (typo, deferred-status drift, or stale decomposition)
 *
 * The single-escape `["internal"]` is honored — internal-only phases don't
 * contribute to coverage but also don't dangle.
 *
 * `opts.legacy = true` (PR #136 review Codex HIGH fix): legacy graceful-skip
 * mode signal from `isLegacyContractMode`. When set, both surfaces collapse
 * to empty arrays — the project predates the UC contract and shouldn't be
 * audited against an empty included set. Mirrors `mpl-require-covers.mjs#isLegacyMode`.
 */
export function findMissingCovers(includedUCs, phases, opts = {}) {
  if (opts.legacy === true) {
    return { uncovered: [], dangling: [] };
  }

  const includedIds = new Set(includedUCs.map(uc => uc.id));

  const claimed = new Set();
  const dangling = [];
  for (const phase of phases) {
    for (const c of phase.covers) {
      if (c === 'internal') continue;
      claimed.add(c);
      if (!includedIds.has(c)) {
        dangling.push({ phase_id: phase.id, uc_id: c, reason: 'phase claims UC not in included user_cases' });
      }
    }
  }

  const uncovered = [];
  for (const uc of includedUCs) {
    if (!claimed.has(uc.id)) {
      uncovered.push({ uc_id: uc.id, title: uc.title, reason: 'no phase covers this included UC' });
    }
  }

  return { uncovered, dangling };
}

/* ────────────────────────── Surface 3: drift ─────────────────────────────── */

/**
 * Compare declared phase impact files against actual git diff. The
 * comparison is over the union of all phase `impact_files` — F6 is a
 * finalize-time audit, so per-phase attribution is less interesting than
 * the rolled-up "what shipped that wasn't planned" / "what was planned
 * that didn't ship" view.
 *
 * Test artifacts and migrations metadata are filtered: regex `^.*\.test\.`
 * matches `__tests__` files and `.test.mjs`, which are auto-derived from
 * implementation files and trivially undeclared. These show up in
 * RUNBOOK's V-05 drift report by design but we don't surface them here.
 *
 * Errors from `git diff` (no commits, not a repo) collapse to empty
 * undeclared/unimplemented — the audit completes with a `git_unavailable: true`
 * note in the surface.
 */
export function findScopeDrift(cwd, phases, opts = {}) {
  const declared = new Set();
  for (const phase of phases) {
    for (const f of phase.impact_files) declared.add(f);
  }

  const actual = collectActualChanges(cwd, opts);
  if (actual === null) {
    return { undeclared: [], unimplemented: [], git_unavailable: true };
  }

  const filtered = actual.filter(f => !/(^|\/)__tests__\//.test(f) && !/\.test\./.test(f));

  const undeclared = filtered.filter(f => !declared.has(f));
  const unimplemented = [...declared].filter(f => !actual.includes(f));

  return { undeclared, unimplemented };
}

function collectActualChanges(cwd, opts = {}) {
  // F6 runs at finalize-time BEFORE the Git Master commit step (5.3), so
  // the implementation is typically still in the working tree (unstaged
  // and/or staged) and not yet committed — and brand-new files are still
  // untracked (no `git add` yet). Probe order:
  //
  //   1. `{ git diff --name-only HEAD; git ls-files --others --exclude-standard; }`
  //      — tracked-modified-vs-HEAD UNION untracked files. PR #136 review
  //      (Codex MEDIUM) fix: pre-fix probe chain missed unstaged created
  //      files entirely; even after switching to `--name-only HEAD` we
  //      still missed pure untracked files (which are the COMMON case at
  //      finalize-time since `git add` hasn't happened yet).
  //   2. `git diff --name-only --cached` — staged-only fallback.
  //   3. merge-base..HEAD — committed range vs default branch. PR #136
  //      review #4 (Claude 🟡): dynamic origin/HEAD lookup so master /
  //      develop / trunk repos aren't penalized.
  //   4. HEAD~20..HEAD — last-20-commits fallback.
  //
  // Returns null when git itself is unreachable.
  const probes = opts.probes ?? [
    '{ git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; }',
    'git diff --name-only --cached 2>/dev/null',
    'git diff --name-only $(git merge-base HEAD $(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main) 2>/dev/null || echo HEAD~20)..HEAD 2>/dev/null',
    'git diff --name-only HEAD~20..HEAD 2>/dev/null',
  ];
  for (const cmd of probes) {
    try {
      const out = execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
      const files = out.split('\n').map(l => l.trim()).filter(Boolean);
      if (files.length > 0) return files;
    } catch { /* try next */ }
  }
  // No diff probe yielded files — distinguish "really clean" from "git missing".
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    return [];
  } catch {
    return null;
  }
}

/* ────────────────────────── Top-level audit runner ───────────────────────── */

/**
 * Run all three surfaces against a workspace and produce the audit-report
 * envelope. Pure data — CLI is responsible for writing it to disk and
 * deriving exit codes.
 *
 * @param {string} cwd - workspace root (the project being audited)
 * @param {string} pluginRoot - MPL plugin root (where anti-patterns.md lives)
 * @returns {{
 *   schema_version: 1,
 *   tier: 4,
 *   generated_at: string,
 *   verdict: 'pass' | 'fail',
 *   summary: { anti_pattern_residual: number, missing_covers: number,
 *              dangling_covers: number, drift_undeclared: number,
 *              drift_unimplemented: number },
 *   surfaces: { ... },
 *   inputs: { decomposition_phases: number, included_ucs: number }
 * }}
 */
export function runCodexAudit(cwd, pluginRoot, opts = {}) {
  const phases = parseDecompositionPhases(cwd);
  const includedUCs = enumerateIncludedUserCases(cwd);
  const fileAbsent = isLegacyContractMode(cwd);
  // PR #136 Codex follow-up fix: Phase 0 graceful-skip writes a real
  // `user-contract.md` with `user_cases: []` (see commands/mpl-run-phase0.md
  // line 228). Treat empty-included as graceful too — same effective contract
  // as file-absent. The two are surfaced separately in `contract_mode` for
  // diagnostic clarity but share the same suppression behavior.
  const emptyIncluded = !fileAbsent && includedUCs.length === 0;
  const graceful = fileAbsent || emptyIncluded;
  const contractMode = fileAbsent ? 'legacy_skip'
    : emptyIncluded ? 'empty_skip'
    : 'enforced';

  const antiPatternResidual = auditAntiPatternResidual(cwd, pluginRoot, phases);
  const { uncovered, dangling } = findMissingCovers(includedUCs, phases, { legacy: graceful });
  const drift = findScopeDrift(cwd, phases, opts);

  const verdict = (antiPatternResidual.length === 0
    && uncovered.length === 0
    && dangling.length === 0)
    ? 'pass'
    : 'fail';

  return {
    schema_version: 1,
    tier: 4,
    generated_at: opts.now ?? new Date().toISOString(),
    verdict,
    contract_mode: contractMode,
    summary: {
      anti_pattern_residual: antiPatternResidual.length,
      missing_covers: uncovered.length,
      dangling_covers: dangling.length,
      drift_undeclared: drift.undeclared.length,
      drift_unimplemented: drift.unimplemented.length,
    },
    surfaces: {
      anti_pattern_residual: antiPatternResidual,
      missing_covers: uncovered,
      dangling_covers: dangling,
      drift,
    },
    inputs: {
      decomposition_phases: phases.length,
      included_ucs: includedUCs.length,
    },
  };
}
