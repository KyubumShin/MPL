#!/usr/bin/env node
/**
 * Machine-readable Tauri/Rust resource-risk probe for doctor audit.
 *
 * Manually invoked diagnostic CLI under hooks/ for plugin packaging
 * compatibility. NOT registered as a Claude hook event.
 *
 * Thin stdin/stdout shim over `hooks/lib/policy/permit.mjs::handleResourceRisk`
 * (Move #10). The policy module wraps `detectTauriRustResourceRisk` —
 * side-effect free; only this wrapper emits JSON.
 *
 * Original implementation: hooks/mpl-resource-risk.legacy.mjs
 */

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { handleResourceRisk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'permit.mjs')).href
);

const cwd = resolve(process.argv[2] || process.cwd());
if (!existsSync(cwd)) {
  console.error(JSON.stringify({ error: `workspace not found: ${cwd}` }));
  process.exit(2);
}

const { payload } = handleResourceRisk({ cwd });
process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
