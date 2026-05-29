#!/usr/bin/env node
/**
 * #239 C2 / #251 — `reviewer_required: false` requires a
 * non-empty `reviewer_rationale` on the same phase.
 *
 * PostToolUse on Edit|Write|MultiEdit. Activates only when the
 * tool wrote `.mpl/mpl/decomposition.yaml`. Parses each phase
 * block. If any phase declares `reviewer_required: false` AND
 * `reviewer_rationale` is missing OR an empty string, blocks
 * the write with a structured reason naming every offending
 * phase id. Pass-through in every other case (no MPL active,
 * other files, `reviewer_required: true` or absent).
 *
 * Mirrors the contract shape already established for
 * `test_agent_required` / `test_agent_rationale` (#212 brief
 * gate + AD-0007 §test_agent_rationale).
 *
 * Telemetry: when the skip is legitimate (rationale non-empty),
 * the executor's Step 12 emits a `reviewer-skipped` record to
 * `.mpl/mpl/quality-signals.jsonl` (#238). This hook does not
 * emit telemetry — it only enforces the rationale shape so
 * the skip path is not silently abused.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { collectFileWrites, isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);

const HOOK_ID = 'mpl-require-reviewer';
const DECOMPOSITION_REL = ['.mpl', 'mpl', 'decomposition.yaml'];

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(
    JSON.stringify({
      continue: false,
      decision: 'block',
      reason,
    }),
  );
}

function parseYamlBoolean(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/[#].*$/, '').trim();
  if (v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === 'no' || v === 'off') return false;
  return null;
}

/**
 * Strip a quoted-string scalar's surrounding quotes (single OR double)
 * and return its inner text. For unquoted scalars, return the raw
 * trimmed value with any trailing `#` comment removed.
 */
function extractScalar(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  // Drop trailing inline comment when outside quotes (heuristic — same
  // shape as mpl-completed-phase-immutability `stripInlineYamlComment`).
  const noCommentMatch = value.match(/^(?:(["']).*?\1|[^#]*)/);
  if (noCommentMatch) value = noCommentMatch[0].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Minimal per-phase parse: scan for `- id: phase-…` blocks, then
 * within each block look for `reviewer_required:` and
 * `reviewer_rationale:` at any indent (they're per-phase fields).
 * Returns [{ id, reviewer_required, reviewer_rationale }, ...].
 */
function parsePhases(text) {
  const phases = [];
  const lines = String(text || '').split('\n');
  let cur = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const idMatch = line.match(/^\s*-\s+id\s*:\s*["']?(phase-[\w.-]+)["']?/);
    if (idMatch) {
      if (cur) phases.push(cur);
      cur = { id: idMatch[1], reviewer_required: null, reviewer_rationale: null };
      continue;
    }
    if (!cur) continue;
    const reqMatch = line.match(/^\s+reviewer_required\s*:\s*(.+)$/);
    if (reqMatch) {
      cur.reviewer_required = parseYamlBoolean(reqMatch[1]);
      continue;
    }
    const ratMatch = line.match(/^\s+reviewer_rationale\s*:\s*(.+)$/);
    if (ratMatch) {
      cur.reviewer_rationale = extractScalar(ratMatch[1]);
      continue;
    }
  }
  if (cur) phases.push(cur);
  return phases;
}

/**
 * Test-only export. The runtime entry below is intentionally not
 * factored through this — it streams stdin and prints — but tests
 * call this with pre-parsed YAML text.
 *
 * Returns { offenders: [phaseId, ...] }.
 */
export function findReviewerRationaleGaps(text) {
  const offenders = [];
  for (const phase of parsePhases(text)) {
    if (phase.reviewer_required === false) {
      const rationale = phase.reviewer_rationale;
      if (rationale == null || rationale.length === 0) {
        offenders.push(phase.id);
      }
    }
  }
  return { offenders };
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    silent();
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    silent();
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    silent();
    return;
  }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) {
    silent();
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const writes = collectFileWrites(toolInput);

  // Find any write targeting decomposition.yaml.
  const decompTail = `${DECOMPOSITION_REL.join('/')}`;
  const decompHit = writes.find(
    (w) => typeof w.filePath === 'string' && w.filePath.endsWith(decompTail),
  );
  if (!decompHit) {
    silent();
    return;
  }

  // Re-read the file from disk after the write — `tool_response` may
  // not carry the full text on Edit/MultiEdit. Disk is authoritative
  // for PostToolUse anyway.
  const onDiskPath = join(cwd, ...DECOMPOSITION_REL);
  let text = '';
  if (existsSync(onDiskPath)) {
    try {
      text = readFileSync(onDiskPath, 'utf-8');
    } catch {
      silent();
      return;
    }
  } else {
    // Write may have been to a path that doesn't materialize as the
    // canonical decomposition file (rare). Fall back to the tool input.
    text = decompHit.text || '';
  }

  const { offenders } = findReviewerRationaleGaps(text);
  if (offenders.length === 0) {
    silent();
    return;
  }

  const list = offenders.map((id) => `  - ${id}`).join('\n');
  block(
    `[MPL #239 C2 / #251] Phase(s) declared \`reviewer_required: false\` ` +
      `without a non-empty \`reviewer_rationale\`:\n${list}\n\n` +
      `When a phase opts out of adversarial review, an authoring note ` +
      `is REQUIRED so the skip is auditable. Add a non-empty ` +
      `\`reviewer_rationale\` string to each phase above, or set ` +
      `\`reviewer_required: true\` (default). Blanket strings like ` +
      `"trivial" are accepted but tracked in \`.mpl/mpl/quality-signals.jsonl\` ` +
      `(#238) for over-use telemetry.`,
  );
}

if (isMain) {
  main().catch(() => {
    // Fail-soft: never break the pipeline on hook IO error.
    silent();
  });
}
