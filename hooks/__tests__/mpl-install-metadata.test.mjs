import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
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

function copyIntoRoot(relativePath, targetRoot) {
  const sourcePath = join(PLUGIN_ROOT, relativePath);
  if (!existsSync(sourcePath) || statSync(sourcePath).isDirectory()) return;
  const targetPath = join(targetRoot, relativePath);
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

function makeSourceArchive(tempRoot) {
  const archiveSource = join(tempRoot, 'archive-source');
  mkdirSync(archiveSource, { recursive: true });

  const trackedFiles = execFileSync('git', ['-C', PLUGIN_ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

  for (const relativePath of new Set([...trackedFiles, 'install.sh'])) {
    copyIntoRoot(relativePath, archiveSource);
  }

  const archivePath = join(tempRoot, 'mpl.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', archiveSource, '.']);
  return archivePath;
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
    const claudeMcp = readJson('.mcp.json');

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
    assert.deepEqual(claudeMcp.mcpServers['mpl-server'], {
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/tools/mpl-mcp-server-launcher.mjs'],
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
    assert.match(codexInstaller, /SOURCE_MODE=\"manifest\"/);
    assert.match(codexInstaller, /\.mpl-install-manifest/);
    assert.match(codexInstaller, /Codex marketplace schema v1/);
    assert.match(codexInstaller, /After updating MPL, rerun/);
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

  it("documents bootstrap installer safeguards", () => {
    const bootstrapInstaller = readText("install.sh");

    assert.match(bootstrapInstaller, /MPL_TARBALL_SHA256/);
    assert.ok(bootstrapInstaller.includes(`! -path "./.mpl-install-manifest"`));
    assert.match(bootstrapInstaller, /ignored while using local MPL source/);
    assert.match(bootstrapInstaller, /Auto-detected Claude Code and Codex CLI/);
    assert.match(bootstrapInstaller, /invalid GitHub repo/);
    assert.match(readText("README.md"), /For reproducible installs, pin a release tag/);
    assert.match(readText("README_ko.md"), /재현 가능한 설치가 필요하면/);
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
      assert.match(output, /After updating MPL, rerun/);
      assert.match(output, /MCP server will prepare dependencies and build on first use/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
  it("bootstraps Claude and Codex from a gitless archive with stub CLIs", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "mpl-bootstrap-install-"));
    try {
      const archivePath = makeSourceArchive(tempRoot);
      const cliStub = join(tempRoot, "runtime-stub.sh");
      const cliLog = join(tempRoot, "runtime.log");
      writeFileSync(cliStub, ["#!/usr/bin/env bash", "printf '%s\\n' \"$*\" >> " + JSON.stringify(cliLog), ""].join("\n"));
      chmodSync(cliStub, 0o755);

      const installRoot = join(tempRoot, "mpl-install");
      const marketplaceRoot = join(tempRoot, "codex-marketplace");
      const output = execFileSync("bash", [join(PLUGIN_ROOT, "install.sh"), "--runtime", "both"], {
        cwd: tempRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_BIN: cliStub,
          CODEX_BIN: cliStub,
          HOME: tempRoot,
          MPL_FORCE_DOWNLOAD: "1",
          MPL_TARBALL_PATH: archivePath,
          MPL_INSTALL_ROOT: installRoot,
          MPL_CODEX_MARKETPLACE_ROOT: marketplaceRoot,
        },
      });

      const sourceRoot = join(installRoot, "source", "mpl");
      assert.ok(existsSync(join(sourceRoot, ".mpl-install-manifest")));
      assert.ok(existsSync(join(sourceRoot, ".claude-plugin", "plugin.json")));
      assert.equal(existsSync(join(sourceRoot, ".git")), false);

      const stagedRoot = join(marketplaceRoot, "plugins", "mpl");
      assert.ok(existsSync(join(stagedRoot, ".codex-plugin", "plugin.json")));
      assert.equal(existsSync(join(stagedRoot, ".mpl-install-manifest")), false);
      assert.equal(existsSync(join(stagedRoot, "mcp-server", "node_modules")), false);
      assert.equal(existsSync(join(stagedRoot, "mcp-server", "dist")), false);

      const cliCalls = readFileSync(cliLog, "utf8");
      assert.match(cliCalls, /plugin validate/);
      assert.match(cliCalls, /plugin marketplace add --scope user/);
      assert.match(cliCalls, /plugin install --scope user mpl/);
      assert.match(cliCalls, /plugin marketplace add/);
      assert.match(cliCalls, /plugin add mpl@mpl/);
      assert.match(output, /Installed MPL source/);
      assert.match(output, /To update MPL later, rerun this install\.sh command/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps local gitless reruns from staging the bootstrap manifest", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "mpl-local-gitless-install-"));
    try {
      const archivePath = makeSourceArchive(tempRoot);
      const localSource = join(tempRoot, "local-source");
      mkdirSync(localSource, { recursive: true });
      execFileSync("tar", ["-xzf", archivePath, "-C", localSource]);

      const codexStub = join(tempRoot, "codex-stub.sh");
      const codexLog = join(tempRoot, "codex.log");
      writeFileSync(codexStub, ["#!/usr/bin/env bash", "printf '%s\\n' \"$*\" >> " + JSON.stringify(codexLog), ""].join("\n"));
      chmodSync(codexStub, 0o755);

      const marketplaceRoot = join(tempRoot, "codex-marketplace");
      const env = {
        ...process.env,
        CODEX_BIN: codexStub,
        HOME: tempRoot,
        MPL_CODEX_MARKETPLACE_ROOT: marketplaceRoot,
      };

      execFileSync("bash", [join(localSource, "install.sh"), "--runtime", "codex"], {
        cwd: tempRoot,
        encoding: "utf8",
        env,
      });
      execFileSync("bash", [join(localSource, "install.sh"), "--runtime", "codex"], {
        cwd: tempRoot,
        encoding: "utf8",
        env,
      });

      const manifest = readFileSync(join(localSource, ".mpl-install-manifest"), "utf8");
      assert.doesNotMatch(manifest, /^\.mpl-install-manifest$/m);

      const stagedRoot = join(marketplaceRoot, "plugins", "mpl");
      assert.ok(existsSync(join(stagedRoot, ".codex-plugin", "plugin.json")));
      assert.equal(existsSync(join(stagedRoot, ".mpl-install-manifest")), false);
      assert.equal(existsSync(join(stagedRoot, "mcp-server", "node_modules")), false);
      assert.equal(existsSync(join(stagedRoot, "mcp-server", "dist")), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ships executable runtime-specific installers", () => {
    for (const script of ["install.sh", "install/claude.sh", "install/codex.sh"]) {
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
