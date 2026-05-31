#!/usr/bin/env node
/**
 * MPL Property Check CLI (F5, #112)
 *
 * Usage:
 *   node hooks/mpl-property-check.mjs <pluginRoot> [config-path...]
 *
 * Default targets: see DEFAULT_CONFIG_TARGETS in lib/mpl-property-check.mjs.
 * Emits JSON to stdout describing declarations / used / unused per config
 * file. Doctor agent Category 15 invokes this and surfaces unused-declaration
 * counts; F5 itself does not enforce — Tier 3 is observational.
 *
 * Exit codes:
 *   0 — audit completed (any unused list surfaces in JSON, doctor decides)
 *   2 — usage error (missing or invalid pluginRoot)
 */

import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { runBatch, DEFAULT_CONFIG_TARGETS } = await import(
  pathToFileURL(`${__dirname}/lib/mpl-property-check.mjs`).href
);

const argRoot = process.argv[2];
const pluginRoot = argRoot
  ? resolve(argRoot)
  : resolve(__dirname, '..');

if (!existsSync(pluginRoot)) {
  console.error(JSON.stringify({ error: `pluginRoot not found: ${pluginRoot}` }));
  process.exit(2);
}

const configPaths = process.argv.slice(3).length > 0
  ? process.argv.slice(3)
  : DEFAULT_CONFIG_TARGETS;

const results = runBatch(pluginRoot, configPaths);
const summary = {
  plugin_root: pluginRoot,
  configs: results,
  totals: {
    declarations: results.reduce((n, r) => n + r.declarations.length, 0),
    used: results.reduce((n, r) => n + r.used.length, 0),
    unused: results.reduce((n, r) => n + r.unused.length, 0),
  },
};

process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
