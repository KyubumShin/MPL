#!/usr/bin/env node
/**
 * Learned Permit Store
 * Manages .mpl/auto-permit-learned.json for adaptive tool auto-approval.
 * Pipeline-scoped: resets when a new pipeline starts (initState clears .mpl/).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

const STORE_FILE = '.mpl/auto-permit-learned.json';

const DEFAULT_STORE = {
  tools: [],
  bash_prefixes: [],
  updated_at: null,
};

/**
 * Read learned permit list
 * @param {string} cwd - Working directory
 * @returns {{ tools: string[], bash_prefixes: string[], updated_at: string|null }}
 */
export function readPermitStore(cwd) {
  try {
    const storePath = join(cwd, STORE_FILE);
    if (!existsSync(storePath)) return { ...DEFAULT_STORE };
    const data = JSON.parse(readFileSync(storePath, 'utf-8'));
    return {
      tools: Array.isArray(data.tools) ? data.tools : [],
      bash_prefixes: Array.isArray(data.bash_prefixes) ? data.bash_prefixes : [],
      updated_at: data.updated_at || null,
    };
  } catch {
    return { ...DEFAULT_STORE };
  }
}

/**
 * Add a learned tool to the permit store
 * @param {string} cwd - Working directory
 * @param {string} toolName - Tool name to learn
 */
export function addLearnedTool(cwd, toolName) {
  const store = readPermitStore(cwd);
  if (store.tools.includes(toolName)) return; // already learned
  store.tools.push(toolName);
  store.updated_at = new Date().toISOString();
  writeStore(cwd, store);
}

/**
 * Add a learned Bash prefix to the permit store
 * @param {string} cwd - Working directory
 * @param {string} prefix - Bash command prefix to learn (e.g., "docker ")
 */
export function addLearnedBashPrefix(cwd, prefix) {
  const store = readPermitStore(cwd);
  if (store.bash_prefixes.includes(prefix)) return; // already learned
  store.bash_prefixes.push(prefix);
  store.updated_at = new Date().toISOString();
  writeStore(cwd, store);
}

/**
 * Check if a tool is in the learned list
 * @param {string} cwd
 * @param {string} toolName
 * @returns {boolean}
 */
export function isLearnedTool(cwd, toolName) {
  const store = readPermitStore(cwd);
  return store.tools.includes(toolName);
}

/**
 * Check if a Bash command matches any learned prefix
 * @param {string} cwd
 * @param {string} command
 * @returns {boolean}
 */
export function isLearnedBashCommand(cwd, command) {
  if (!command) return false;
  const store = readPermitStore(cwd);
  const trimmed = command.trim();
  return store.bash_prefixes.some(prefix => trimmed.startsWith(prefix));
}

/**
 * Extract learnable prefix from a Bash command.
 * Takes the first token + space as the prefix.
 * @param {string} command
 * @returns {string} prefix (e.g., "docker ")
 */
export function extractBashPrefix(command) {
  if (!command) return '';
  const trimmed = command.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return trimmed;
  return trimmed.slice(0, spaceIdx + 1); // include trailing space
}

function writeStore(cwd, store) {
  const dir = join(cwd, '.mpl');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.permit-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmpPath, join(cwd, STORE_FILE));
}
