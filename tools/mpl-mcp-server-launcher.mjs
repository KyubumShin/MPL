#!/usr/bin/env node
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const MCP_DIR = join(PLUGIN_ROOT, 'mcp-server');
const DIST_ENTRY = join(MCP_DIR, 'dist', 'index.js');
const DEPS_MARKER = join(MCP_DIR, 'node_modules', '@modelcontextprotocol');

function runSetupCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: MCP_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    process.stderr.write(`[MPL] MCP setup failed: ${command} ${args.join(' ')}\n`);
    process.exit(result.status || 1);
  }
}

if (!existsSync(DIST_ENTRY) || !existsSync(DEPS_MARKER)) {
  process.stderr.write('[MPL] Preparing MCP server for first use...\n');
  runSetupCommand('npm', ['install']);
  runSetupCommand('npm', ['run', 'build']);
}

const child = spawn(process.execPath, [DIST_ENTRY], {
  cwd: MCP_DIR,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
    process.exit(signalExitCodes[signal] ?? 1);
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  process.stderr.write(`[MPL] Failed to start MCP server: ${error.message}\n`);
  process.exit(1);
});
