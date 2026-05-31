#!/usr/bin/env node
/**
 * MPL Property Check CLI (F5, #112)
 *
 * Thin CLI shim over `hooks/lib/policy/schemas.mjs::handlePropertyAudit`
 * (Move #11). The policy module owns the audit pipeline; this wrapper
 * preserves the CLI contract:
 *
 *   node hooks/mpl-property-check.mjs <pluginRoot> [config-path...]
 *
 * Default targets: see DEFAULT_CONFIG_TARGETS in lib/mpl-property-check.mjs
 * (re-exported by the policy module).
 *
 * Exit codes:
 *   0 — audit completed (any unused list surfaces in JSON, doctor decides)
 *   2 — usage error (missing or invalid pluginRoot)
 *
 * Original implementation: hooks/mpl-property-check.legacy.mjs
 */

import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const {
  handle: schemasHandle,
  DEFAULT_CONFIG_TARGETS,
} = await import(
  pathToFileURL(`${__dirname}/lib/policy/schemas.mjs`).href
);

function runCli(argv) {
  const argRoot = argv[2];
  const pluginRoot = argRoot
    ? resolve(argRoot)
    : resolve(__dirname, '..');

  if (!existsSync(pluginRoot)) {
    console.error(JSON.stringify({ error: `pluginRoot not found: ${pluginRoot}` }));
    return 2;
  }

  const configPaths = argv.slice(3).length > 0
    ? argv.slice(3)
    : DEFAULT_CONFIG_TARGETS;

  const decision = schemasHandle('property_audit', {
    pluginRoot,
    configPaths,
  });

  if (decision.action !== 'report' || !decision.payload) {
    console.error(JSON.stringify({ error: 'property_audit returned no payload' }));
    return 2;
  }

  process.stdout.write(JSON.stringify(decision.payload, null, 2) + '\n');
  return 0;
}

if (isMain) {
  process.exit(runCli(process.argv));
}

export { DEFAULT_CONFIG_TARGETS, runCli };
