#!/usr/bin/env node
/**
 * Machine-readable Tauri/Rust resource-risk probe for doctor audit.
 *
 * Emits JSON and never blocks by itself; policy consumers decide whether WARN
 * should remain advisory or become an enforcement signal.
 */

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { detectTauriRustResourceRisk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-resource-risk.mjs')).href
);

const cwd = resolve(process.argv[2] || process.cwd());
if (!existsSync(cwd)) {
  console.error(JSON.stringify({ error: `workspace not found: ${cwd}` }));
  process.exit(2);
}

process.stdout.write(JSON.stringify(detectTauriRustResourceRisk(cwd), null, 2) + '\n');
