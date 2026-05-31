#!/usr/bin/env node
/**
 * Thin CLI wrapper around `writeState(cwd, patch)` from
 * `hooks/lib/state/writer.mjs`. Exists so the MCP-server side
 * (`mcp-server/src/lib/state-manager.ts`) can synchronously shell out to
 * the canonical hooks-side writer instead of maintaining a divergent TS
 * port. See Move #3 of the v2 plan.
 *
 * Protocol:
 *   Inputs:
 *     - argv:    --cwd <projectRoot>
 *     - stdin:   one JSON object (the patch). Trailing newline allowed.
 *   Outputs:
 *     - stdout:  one JSON object `{ success, updated_keys, reason? }`.
 *     - exit 0 on success or expected rejection (I13 / H8 surfaced via
 *       `success:false, reason`). The MCP caller forwards the JSON
 *       verbatim to `handleStateWrite`.
 *     - exit >0 only on programmer / I/O errors (bad argv, JSON parse
 *       failure, fs/EACCES). MCP-side maps non-zero exit to
 *       `{success:false, reason:'[MPL state] writer subprocess failed: ...'}`.
 *
 * Why a separate CLI process and not a TS-side dynamic `import()`?
 *   - MCP TS builds to ESM with `module: Node16`; importing an `.mjs`
 *     from compiled JS works at runtime but ties build-output layout to
 *     a sibling repo path. A subprocess keeps the hooks code in its own
 *     resolution context (it can `import { loadConfig } from
 *     '../mpl-config.mjs'` without the MCP build needing to vendor it).
 *   - The subprocess boundary also makes any new writer-side rule (I5,
 *     I13, H8, ring-buffer caps) automatically pick up on the MCP path
 *     — there is no "second authoritative writer" to keep in sync.
 *
 * I13 enforcement:
 *   The hooks-side `writeState` does NOT enforce I13 itself — I13 lives
 *   in `mpl-state-invariant.mjs` (PreToolUse) and `mpl-phase-controller`
 *   (Stop hook). The MCP `mpl_state_write` path bypasses both, so this
 *   CLI runs `blockedPhaseTransitionReason` against the POST-MERGE
 *   `current_phase` BEFORE delegating to `writeState`. This mirrors what
 *   the pre-Move-#3 MCP-side state-manager.ts did, and what the hook
 *   layer would catch on a regular Edit/Write of `.mpl/state.json`.
 */

import { readSync } from 'fs';

import { writeState, UnsupportedSchemaVersionError } from './writer.mjs';
import { readState } from './reader.mjs';
import { deepMerge } from '../mpl-state-merge.mjs';
import { blockedPhaseTransitionReason } from '../mpl-phase0-artifacts.mjs';

function parseArgs(argv) {
  let cwd = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') {
      cwd = argv[++i];
    } else if (a.startsWith('--cwd=')) {
      cwd = a.slice('--cwd='.length);
    }
  }
  return { cwd };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/**
 * Slurp stdin synchronously. The parent (MCP-side spawnSync) writes the
 * patch JSON to stdin and closes it before reading stdout, so the loop
 * terminates on EOF (0-byte read) without hanging.
 */
function readStdinSync() {
  const chunks = [];
  const BUF_SIZE = 65536;
  const buf = Buffer.alloc(BUF_SIZE);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let bytes = 0;
    try {
      bytes = readSync(0, buf, 0, BUF_SIZE, null);
    } catch (err) {
      // EAGAIN — shouldn't happen with spawnSync's piped stdin (blocking
      // by default), but be defensive.
      if (err && err.code === 'EAGAIN') continue;
      // EOF on platforms that surface end-of-stream as an error.
      if (err && err.code === 'EOF') break;
      throw err;
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function main() {
  const { cwd } = parseArgs(process.argv);
  if (!cwd) {
    process.stderr.write('[writer-cli] missing required --cwd <projectRoot>\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = readStdinSync();
  } catch (err) {
    process.stderr.write(`[writer-cli] stdin read failed: ${err && err.message ? err.message : err}\n`);
    process.exit(3);
  }

  let patch;
  try {
    patch = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[writer-cli] invalid patch JSON on stdin: ${err && err.message ? err.message : err}\n`);
    process.exit(4);
  }

  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    process.stderr.write('[writer-cli] patch must be a JSON object\n');
    process.exit(4);
  }

  // I13 pre-check (post-merge current_phase). Mirrors the MCP-side
  // behavior before Move #3 and the pre-transition guard already used by
  // mpl-phase-controller on the hooks Stop hook path. Done here rather
  // than inside writer.mjs because the hooks writer's main callers
  // (phase-controller, ambiguity-gate) already gate I13 upstream and
  // would double-pay the artifact existsSync cost on every write.
  let merged = patch;
  try {
    const current = readState(cwd);
    merged = deepMerge(current ?? {}, patch);
  } catch {
    // readState already swallows parse errors and returns null; this
    // catch is for defense-in-depth so a corrupt state.json doesn't
    // wedge writeState before H8 has a chance to fire.
    merged = patch;
  }

  const mergedPhase = typeof merged.current_phase === 'string' ? merged.current_phase : '';
  if (mergedPhase) {
    try {
      const blocked = blockedPhaseTransitionReason(cwd, mergedPhase);
      if (blocked) {
        emit({ success: false, updated_keys: [], reason: blocked });
        process.exit(0);
      }
    } catch (err) {
      // Treat an I13 check failure as fail-closed: surface as a writer
      // error rather than silently allowing the write.
      process.stderr.write(`[writer-cli] I13 check failed: ${err && err.message ? err.message : err}\n`);
      process.exit(5);
    }
  }

  try {
    writeState(cwd, patch);
    emit({ success: true, updated_keys: Object.keys(patch) });
    process.exit(0);
  } catch (err) {
    if (err instanceof UnsupportedSchemaVersionError) {
      emit({
        success: false,
        updated_keys: [],
        reason: `[MPL H8] ${err.message}`,
      });
      process.exit(0);
    }
    // Any other throw is a true subprocess failure: surface to stderr
    // and exit non-zero so the MCP-side shim returns a synthetic
    // failure object with the stderr tail.
    process.stderr.write(`[writer-cli] writeState failed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  }
}

main();
