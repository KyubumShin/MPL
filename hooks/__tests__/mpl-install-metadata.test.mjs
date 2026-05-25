import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, relativePath), 'utf8'));
}

function readText(relativePath) {
  return readFileSync(join(PLUGIN_ROOT, relativePath), 'utf8');
}

describe('dual-runtime install metadata', () => {
  it('keeps Claude, Codex, MCP, and docs versions aligned', () => {
    const claudePlugin = readJson('.claude-plugin/plugin.json');
    const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
    const codexPlugin = readJson('.codex-plugin/plugin.json');
    const mcpPackage = readJson('mcp-server/package.json');
    const mcpLock = readJson('mcp-server/package-lock.json');

    const version = claudePlugin.version;
    assert.match(version, /^\d+\.\d+\.\d+$/);

    assert.equal(claudeMarketplace.version, version);
    assert.equal(claudeMarketplace.plugins[0].version, version);
    assert.equal(codexPlugin.version, version);
    assert.equal(mcpPackage.version, version);
    assert.equal(mcpLock.version, version);
    assert.equal(mcpLock.packages[''].version, version);

    assert.match(readText('README.md').split('\n')[0], new RegExp(`v${version}$`));
    assert.match(readText('README_ko.md').split('\n')[0], new RegExp(`v${version}$`));
    assert.match(readText('docs/design.md').split('\n')[0], new RegExp(`v${version} Design Document$`));
    assert.match(readText('docs/config-schema.md'), new RegExp(`\\*\\*Version\\*\\*: v${version}\\b`));
  });

  it('exposes a Codex plugin manifest with shared skills and MCP server config', () => {
    const codexPlugin = readJson('.codex-plugin/plugin.json');
    const codexMcp = readJson('.codex-plugin/.mcp.json');

    assert.equal(codexPlugin.name, 'mpl');
    assert.equal(codexPlugin.skills, './skills/');
    assert.equal(codexPlugin.mcpServers, './.codex-plugin/.mcp.json');
    assert.equal(codexPlugin.interface.displayName, 'MPL');
    assert.ok(codexPlugin.interface.defaultPrompt.length <= 3);
    assert.ok(codexPlugin.interface.defaultPrompt.every((prompt) => prompt.length <= 128));

    assert.ok(existsSync(join(PLUGIN_ROOT, 'skills', 'mpl', 'SKILL.md')));
    assert.deepEqual(codexMcp.mcpServers['mpl-server'], {
      command: 'node',
      args: ['./tools/mpl-mcp-server-launcher.mjs'],
      cwd: '.',
    });
    assert.ok(existsSync(join(PLUGIN_ROOT, 'tools', 'mpl-mcp-server-launcher.mjs')));
  });

  it('publishes MPL through a Codex marketplace entry', () => {
    const marketplace = readJson('.agents/plugins/marketplace.json');
    const [entry] = marketplace.plugins;

    assert.equal(marketplace.name, 'mpl');
    assert.equal(marketplace.interface.displayName, 'MPL');
    assert.equal(entry.name, 'mpl');
    assert.equal(entry.source.source, 'local');
    assert.equal(entry.source.path, './plugins/mpl');
    assert.equal(entry.policy.installation, 'INSTALLED_BY_DEFAULT');
    assert.equal(entry.policy.authentication, 'ON_INSTALL');
    assert.equal(entry.category, 'Coding');
  });

  it("ships executable runtime-specific installers", () => {
    for (const script of ["install/claude.sh", "install/codex.sh"]) {
      const scriptPath = join(PLUGIN_ROOT, script);
      assert.ok(existsSync(scriptPath));
      assert.ok((statSync(scriptPath).mode & 0o111) !== 0, script + " must be executable");
      execFileSync("bash", ["-n", scriptPath]);
    }

    const codexInstaller = readText("install/codex.sh");
    assert.match(codexInstaller, /plugins\/mpl/);
    assert.match(codexInstaller, /\$\{CODEX_BIN\}" plugin marketplace add/);
    assert.match(codexInstaller, /\$\{CODEX_BIN\}" plugin add mpl@mpl/);

    const claudeInstaller = readText("install/claude.sh");
    assert.match(claudeInstaller, /\$\{CLAUDE_BIN\}" plugin marketplace add/);
    assert.match(claudeInstaller, /\$\{CLAUDE_BIN\}" plugin install/);
  });
});
