#!/usr/bin/env node
/**
 * MPL Doctor Meta-Self CLI (F4, #106)
 *
 * Thin CLI wrapper that emits `runMetaSelf(pluginRoot)` as JSON to stdout.
 * Invoked by `agents/mpl-doctor.md` Category 14 via Bash:
 *
 *   node "${CLAUDE_PLUGIN_ROOT}/cli/mpl-doctor-meta-self.mjs" "${CLAUDE_PLUGIN_ROOT}"
 *
 * Move #15: this file used to live at hooks/mpl-doctor-meta-self.mjs but it is
 * a standalone CLI, not a Claude Code hook. Hosting it under cli/ keeps hooks/
 * exclusively for the engine + per-event policy wrappers.
 *
 * Exit codes:
 *   0 — audit completed (any hits surface in the JSON; doctor agent decides
 *       PASS/WARN/FAIL based on the output)
 *   2 — usage error (missing or invalid pluginRoot)
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// runMetaSelf lives under hooks/lib/ — keep the implementation there because
// it is shared by other diagnostics. cli/ → ../hooks/lib/ is the canonical
// import path from this file.
const { runMetaSelf } = await import(
  pathToFileURL(join(__dirname, '..', 'hooks', 'lib', 'mpl-meta-self.mjs')).href
);

const argRoot = process.argv[2];
const pluginRoot = argRoot
  ? resolve(argRoot)
  : resolve(__dirname, '..'); // default: this file lives at cli/, so parent = plugin root

if (!existsSync(pluginRoot)) {
  console.error(JSON.stringify({ error: `pluginRoot not found: ${pluginRoot}` }));
  process.exit(2);
}

const result = runMetaSelf(pluginRoot);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
