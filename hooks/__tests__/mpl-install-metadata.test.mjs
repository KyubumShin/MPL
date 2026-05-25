import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
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

  it("uses the Codex installer as the single marketplace source", () => {
    assert.equal(existsSync(join(PLUGIN_ROOT, ".agents/plugins/marketplace.json")), false);

    const codexInstaller = readText("install/codex.sh");
    assert.match(codexInstaller, /MARKETPLACE_JSON=.*\.agents\/plugins\/marketplace\.json/);
    assert.match(codexInstaller, /PLUGIN_ROOT=.*plugins\/mpl/);
    assert.match(codexInstaller, /git -C .*\$\{REPO_ROOT\}.*ls-files -z/);
    assert.match(codexInstaller, /untracked files are not included/);
    assert.match(codexInstaller, /Codex marketplace schema v1/);
    assert.match(codexInstaller, /After git pull or local edits, rerun/);
    assert.doesNotMatch(codexInstaller, /ln -s/);
    assert.doesNotMatch(codexInstaller, /tar -C/);
    assert.match(codexInstaller, /\"name\": \"mpl\"/);
    assert.match(codexInstaller, /\"displayName\": \"MPL\"/);
    assert.match(codexInstaller, /\"source\": \"local\"/);
    assert.match(codexInstaller, /\"path\": \"\.\/plugins\/mpl\"/);
    assert.match(codexInstaller, /\"installation\": \"INSTALLED_BY_DEFAULT\"/);
    assert.match(codexInstaller, /\"authentication\": \"ON_INSTALL\"/);
    assert.match(codexInstaller, /\"category\": \"Coding\"/);
  });

  it("stages a clean Codex plugin root with a stub CLI", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "mpl-codex-install-"));
    try {
      const codexStub = join(tempRoot, "codex-stub.sh");
      const codexLog = join(tempRoot, "codex.log");
      writeFileSync(codexStub, ["#!/usr/bin/env bash", "printf '%s\\n' \"$*\" >> " + JSON.stringify(codexLog), ""].join("\n"));
      chmodSync(codexStub, 0o755);

      const marketplaceRoot = join(tempRoot, "marketplace");
      const output = execFileSync("bash", [join(PLUGIN_ROOT, "install/codex.sh")], {
        cwd: PLUGIN_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_BIN: codexStub,
          HOME: tempRoot,
          MPL_CODEX_MARKETPLACE_ROOT: marketplaceRoot,
        },
      });

      const stagedRoot = join(marketplaceRoot, "plugins", "mpl");
      assert.ok(existsSync(join(stagedRoot, ".codex-plugin", "plugin.json")));
      assert.ok(existsSync(join(stagedRoot, "skills", "mpl", "SKILL.md")));
      assert.equal(existsSync(join(stagedRoot, ".git")), false);
      assert.equal(existsSync(join(stagedRoot, ".mpl")), false);
      assert.equal(existsSync(join(stagedRoot, ".pr-review-state")), false);
      assert.equal(existsSync(join(stagedRoot, ".claude")), false);
      assert.equal(existsSync(join(stagedRoot, "mcp-server", "node_modules")), false);
      assert.equal(existsSync(join(stagedRoot, "mcp-server", "dist")), false);

      const marketplace = JSON.parse(readFileSync(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
      assert.equal(marketplace.plugins[0].source.path, "./plugins/mpl");

      const codexCalls = readFileSync(codexLog, "utf8");
      assert.match(codexCalls, /plugin marketplace add/);
      assert.match(codexCalls, /plugin add mpl@mpl/);
      assert.match(output, /After git pull or local edits, rerun/);
      assert.match(output, /MCP server will prepare dependencies and build on first use/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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
