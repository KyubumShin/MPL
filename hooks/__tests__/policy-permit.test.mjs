/**
 * Tests for hooks/lib/policy/permit.mjs (Move #10).
 *
 * Synthetic state + cwd fixtures. The wrapper hooks delegate to this module
 * — these tests validate the policy module in isolation. The headline
 * regression test exercises the eval-finding #1c fail-open closure:
 * unknown Bash commands now `pass-through` (or block-strict / allow-loose
 * per the new `permit.unknown_bash` knob), never the legacy
 * `decision: 'approve'`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  handle,
  handleAutoPermit,
  handlePermitLearner,
  handleBashTimeout,
  handleResourceRisk,
  handleFallbackGrep,
  classifyBashCommand,
  resolveUnknownBashPolicy,
  ALWAYS_SAFE_TOOLS,
  DEFER_TOOLS,
  SAFE_BASH_PREFIXES,
  DANGEROUS_BASH_PATTERNS,
  UNKNOWN_BASH_DEFAULT,
  PERMIT_HOOK_IDS,
  PERMIT_LEARNED_STORE_PATH,
} from '../lib/policy/permit.mjs';

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-policy-permit-'));
  mkdirSync(join(dir, '.mpl', 'signals'), { recursive: true });
  // Active MPL state — minimal seed.
  writeFileSync(join(dir, '.mpl', 'state.json'), JSON.stringify({
    schema_version: 2,
    current_phase: 'phase2-sprint',
  }));
  return dir;
}

function writeConfig(dir, cfg) {
  writeFileSync(join(dir, '.mpl', 'config.json'), JSON.stringify(cfg));
}

// ============================================================================
// Public constant exports — back-compat surface
// ============================================================================

describe('public constant exports', () => {
  it('exposes ALWAYS_SAFE_TOOLS as a Set containing Read/Glob/Grep', () => {
    assert.ok(ALWAYS_SAFE_TOOLS instanceof Set);
    assert.ok(ALWAYS_SAFE_TOOLS.has('Read'));
    assert.ok(ALWAYS_SAFE_TOOLS.has('Glob'));
    assert.ok(ALWAYS_SAFE_TOOLS.has('Grep'));
  });
  it('exposes DEFER_TOOLS containing Edit and Write', () => {
    assert.ok(DEFER_TOOLS.has('Edit'));
    assert.ok(DEFER_TOOLS.has('Write'));
  });
  it('exposes SAFE_BASH_PREFIXES including common commands', () => {
    assert.ok(Array.isArray(SAFE_BASH_PREFIXES));
    assert.ok(SAFE_BASH_PREFIXES.includes('git status'));
    assert.ok(SAFE_BASH_PREFIXES.includes('ls'));
  });
  it('exposes DANGEROUS_BASH_PATTERNS array with legacy entries', () => {
    assert.ok(Array.isArray(DANGEROUS_BASH_PATTERNS));
    assert.ok(DANGEROUS_BASH_PATTERNS.some((p) => p.test('git push --force')));
    assert.ok(DANGEROUS_BASH_PATTERNS.some((p) => p.test('sudo rm /')));
  });
  it('exposes UNKNOWN_BASH_DEFAULT = pass-through', () => {
    assert.equal(UNKNOWN_BASH_DEFAULT, 'pass-through');
  });
  it('exposes PERMIT_HOOK_IDS with the five canonical IDs', () => {
    assert.equal(PERMIT_HOOK_IDS.auto_permit, 'mpl-auto-permit');
    assert.equal(PERMIT_HOOK_IDS.permit_learner, 'mpl-permit-learner');
    assert.equal(PERMIT_HOOK_IDS.bash_timeout, 'mpl-bash-timeout');
    assert.equal(PERMIT_HOOK_IDS.resource_risk, 'mpl-resource-risk');
    assert.equal(PERMIT_HOOK_IDS.fallback_grep, 'mpl-fallback-grep');
  });
  it('exposes PERMIT_LEARNED_STORE_PATH', () => {
    assert.equal(PERMIT_LEARNED_STORE_PATH, '.mpl/auto-permit-learned.json');
  });
});

// ============================================================================
// resolveUnknownBashPolicy
// ============================================================================

describe('resolveUnknownBashPolicy', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('defaults to pass-through when no config present', () => {
    assert.equal(resolveUnknownBashPolicy(tmp), 'pass-through');
  });

  it('reads .mpl/config.json#permit.unknown_bash', () => {
    writeConfig(tmp, { permit: { unknown_bash: 'block-strict' } });
    assert.equal(resolveUnknownBashPolicy(tmp), 'block-strict');
  });

  it('falls back to passed config when .mpl/config.json absent', () => {
    const v = resolveUnknownBashPolicy(tmp, { permit: { unknown_bash: 'allow-loose' } });
    assert.equal(v, 'allow-loose');
  });

  it('ignores invalid values and falls back to default', () => {
    writeConfig(tmp, { permit: { unknown_bash: 'invalid-mode' } });
    assert.equal(resolveUnknownBashPolicy(tmp), 'pass-through');
  });

  it('.mpl/config.json takes precedence over passed config', () => {
    writeConfig(tmp, { permit: { unknown_bash: 'block-strict' } });
    assert.equal(
      resolveUnknownBashPolicy(tmp, { permit: { unknown_bash: 'allow-loose' } }),
      'block-strict',
    );
  });
});

// ============================================================================
// classifyBashCommand — SSOT veto pipeline
// ============================================================================

describe('classifyBashCommand', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns no veto for plain safe commands', () => {
    const r = classifyBashCommand(tmp, 'ls -la');
    assert.equal(r.veto, null);
    assert.equal(r.dangerous, false);
  });

  it('vetoes legacy dangerous patterns (git push --force)', () => {
    const r = classifyBashCommand(tmp, 'git push --force origin main');
    assert.ok(r.veto);
    assert.equal(r.veto.category, 'dangerous_bash');
    assert.equal(r.dangerous, true);
  });

  it('vetoes legacy dangerous patterns (sudo)', () => {
    const r = classifyBashCommand(tmp, 'sudo apt-get install foo');
    assert.ok(r.veto);
    assert.equal(r.veto.category, 'dangerous_bash');
  });

  it('vetoes source-edit DANGEROUS_BASH_PATTERNS (kubectl delete)', () => {
    const r = classifyBashCommand(tmp, 'kubectl delete pod foo');
    assert.ok(r.veto);
    assert.equal(r.veto.category, 'dangerous_bash');
  });

  it('vetoes source-edit DANGEROUS_BASH_PATTERNS (chmod 777)', () => {
    const r = classifyBashCommand(tmp, 'chmod 777 /etc/passwd');
    assert.ok(r.veto);
    assert.equal(r.veto.category, 'dangerous_bash');
  });

  it('vetoes protected-delete on .mpl/contracts', () => {
    const r = classifyBashCommand(tmp, 'rm -rf .mpl/contracts');
    assert.ok(r.veto);
    // protected delete is reached only if dangerous-union doesn't fire first;
    // `rm -rf` on .mpl is explicitly allowed by legacy regex, so this should
    // land in protected_delete.
    assert.ok(['protected_delete', 'dangerous_bash'].includes(r.veto.category));
  });

  it('vetoes destructive writes targeting docs/learnings', () => {
    const r = classifyBashCommand(tmp, 'find docs/learnings -delete');
    assert.ok(r.veto);
    assert.equal(r.veto.category, 'protected_delete');
  });

  it('vetoes redirect-write to .mpl/state.json', () => {
    const r = classifyBashCommand(tmp, 'echo "{}" > .mpl/state.json');
    assert.ok(r.veto);
    // could be state_json_write or protected_delete depending on layer order;
    // both are acceptable as the command IS vetoed.
    assert.ok(['state_json_write', 'protected_delete', 'dangerous_bash'].includes(r.veto.category));
  });

  it('vetoes tee-write to source file (src/app.ts)', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    const r = classifyBashCommand(tmp, 'tee src/app.ts < /tmp/x');
    assert.ok(r.veto, 'should veto tee to src/app.ts');
    assert.equal(r.veto.category, 'source_target');
  });

  it('vetoes echo-redirect to source file', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    const r = classifyBashCommand(tmp, "echo 'x' > src/app.ts");
    assert.ok(r.veto);
    assert.equal(r.veto.category, 'source_target');
  });

  it('does NOT veto echo-redirect to /tmp/ scratch', () => {
    const r = classifyBashCommand(tmp, 'echo x > /tmp/scratch.txt');
    assert.equal(r.veto, null);
  });

  it('does NOT veto when target is inside .mpl/ allowlist', () => {
    const r = classifyBashCommand(tmp, 'echo "x" > .mpl/cache/foo.txt');
    assert.equal(r.veto, null);
  });
});

// ============================================================================
// handleAutoPermit
// ============================================================================

describe('handleAutoPermit', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('pass-through when MPL inactive', () => {
    rmSync(join(tmp, '.mpl', 'state.json'));
    const d = handleAutoPermit({ cwd: tmp, toolName: 'Read', isMplActive: false });
    assert.equal(d.action, 'pass-through');
  });

  it('pass-through for DEFER_TOOLS (Edit / Write)', () => {
    const d = handleAutoPermit({ cwd: tmp, toolName: 'Edit', isMplActive: true });
    assert.equal(d.action, 'pass-through');
  });

  it('approve for ALWAYS_SAFE_TOOLS (Read)', () => {
    const d = handleAutoPermit({ cwd: tmp, toolName: 'Read', isMplActive: true });
    assert.equal(d.action, 'approve');
  });

  it('approve safe Bash prefix (ls)', () => {
    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
      isMplActive: true,
    });
    assert.equal(d.action, 'approve');
  });

  it('pass-through on dangerous Bash (NOT block) — write-guard owns the block', () => {
    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'git push --force origin main' },
      isMplActive: true,
    });
    assert.equal(d.action, 'pass-through');
    assert.equal(d.vetoCategory, 'dangerous_bash');
  });

  it('eval finding #1c fix — UNKNOWN bash NO LONGER auto-approves (default pass-through)', () => {
    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'unknown-binary --arg' },
      isMplActive: true,
    });
    assert.notEqual(d.action, 'approve');
    assert.equal(d.action, 'pass-through');
  });

  it('permit.unknown_bash=block-strict → block on unknown bash', () => {
    writeConfig(tmp, { permit: { unknown_bash: 'block-strict' } });
    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'mystery-tool x' },
      isMplActive: true,
    });
    assert.equal(d.action, 'block');
    assert.match(d.reason, /unknown_bash=block-strict/);
  });

  it('permit.unknown_bash=allow-loose → restores legacy approve', () => {
    writeConfig(tmp, { permit: { unknown_bash: 'allow-loose' } });
    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'mystery-tool x' },
      isMplActive: true,
    });
    assert.equal(d.action, 'approve');
  });

  it('source-target veto runs BEFORE SAFE_BASH_PREFIXES (echo > src/app.ts)', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: "echo 'x' > src/app.ts" },
      isMplActive: true,
    });
    assert.equal(d.action, 'pass-through');
    assert.equal(d.vetoCategory, 'source_target');
  });

  it('echo to /tmp scratch still approves via SAFE_BASH_PREFIXES', () => {
    const d = handleAutoPermit({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'echo x > /tmp/scratch.txt' },
      isMplActive: true,
    });
    assert.equal(d.action, 'approve');
  });
});

// ============================================================================
// handlePermitLearner — symmetric veto
// ============================================================================

describe('handlePermitLearner', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('noop when MPL inactive', () => {
    rmSync(join(tmp, '.mpl', 'state.json'));
    const d = handlePermitLearner({ cwd: tmp, toolName: 'Bash', isMplActive: false });
    assert.equal(d.action, 'noop');
  });

  it('noop for ALWAYS_SAFE_TOOLS', () => {
    const d = handlePermitLearner({ cwd: tmp, toolName: 'Read', isMplActive: true });
    assert.equal(d.action, 'noop');
  });

  it('noop for DEFER_TOOLS', () => {
    const d = handlePermitLearner({ cwd: tmp, toolName: 'Edit', isMplActive: true });
    assert.equal(d.action, 'noop');
  });

  it('veto-skip on dangerous Bash — never persists', () => {
    const d = handlePermitLearner({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'git push --force' },
      isMplActive: true,
    });
    assert.equal(d.action, 'veto-skip');
    assert.equal(d.vetoCategory, 'dangerous_bash');
  });

  it('veto-skip on source-target writes — never persists', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    const d = handlePermitLearner({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: "echo 'x' > src/app.ts" },
      isMplActive: true,
    });
    assert.equal(d.action, 'veto-skip');
    assert.equal(d.vetoCategory, 'source_target');
  });

  it('noop on already-builtin-safe Bash', () => {
    const d = handlePermitLearner({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      isMplActive: true,
    });
    assert.equal(d.action, 'noop');
  });

  it('learn-bash-prefix for novel non-vetoed Bash', () => {
    const d = handlePermitLearner({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'novel-tool --arg value' },
      isMplActive: true,
    });
    assert.equal(d.action, 'learn-bash-prefix');
    assert.equal(d.prefix, 'novel-tool ');
  });

  it('learn-tool for novel non-Bash tool', () => {
    const d = handlePermitLearner({
      cwd: tmp,
      toolName: 'CustomTool',
      isMplActive: true,
    });
    assert.equal(d.action, 'learn-tool');
    assert.equal(d.toolName, 'CustomTool');
  });
});

// ============================================================================
// handleBashTimeout
// ============================================================================

describe('handleBashTimeout', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('silent when tool is not Bash', () => {
    const d = handleBashTimeout({ cwd: tmp, toolName: 'Read', isMplActive: true });
    assert.equal(d.action, 'silent');
  });

  it('silent when MPL inactive', () => {
    rmSync(join(tmp, '.mpl', 'state.json'));
    const d = handleBashTimeout({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'vitest run' },
      isMplActive: false,
    });
    assert.equal(d.action, 'silent');
  });

  it('silent on non-verification commands', () => {
    const d = handleBashTimeout({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
      isMplActive: true,
    });
    assert.equal(d.action, 'silent');
  });

  it('warn (default non-strict) when verification command lacks timeout', () => {
    const d = handleBashTimeout({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'vitest run' },
      isMplActive: true,
    });
    assert.equal(d.action, 'warn');
    assert.match(d.reason, /MPL G1/);
  });
});

// ============================================================================
// handleResourceRisk
// ============================================================================

describe('handleResourceRisk', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns { action: report, payload } without throwing', () => {
    const d = handleResourceRisk({ cwd: tmp });
    assert.equal(d.action, 'report');
    assert.ok(d.payload && typeof d.payload === 'object');
  });
});

// ============================================================================
// handleFallbackGrep
// ============================================================================

describe('handleFallbackGrep', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('silent for non-Edit/Write/MultiEdit tools', () => {
    const d = handleFallbackGrep({ cwd: tmp, toolName: 'Bash', isMplActive: true });
    assert.equal(d.action, 'silent');
  });

  it('silent when MPL inactive', () => {
    rmSync(join(tmp, '.mpl', 'state.json'));
    const d = handleFallbackGrep({
      cwd: tmp,
      toolName: 'Edit',
      toolInput: { file_path: 'a.ts' },
      isMplActive: false,
    });
    assert.equal(d.action, 'silent');
  });

  it('silent when no file paths in toolInput', () => {
    const d = handleFallbackGrep({
      cwd: tmp,
      toolName: 'Edit',
      toolInput: {},
      isMplActive: true,
    });
    assert.equal(d.action, 'silent');
  });

  it('silent when pluginRoot not provided (no registry to load)', () => {
    const d = handleFallbackGrep({
      cwd: tmp,
      toolName: 'Edit',
      toolInput: { file_path: 'a.ts' },
      isMplActive: true,
    });
    assert.equal(d.action, 'silent');
  });
});

// ============================================================================
// Dispatcher
// ============================================================================

describe('handle dispatcher', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('routes auto_permit to handleAutoPermit', () => {
    const d = handle('auto_permit', { cwd: tmp, toolName: 'Read', isMplActive: true });
    assert.equal(d.action, 'approve');
  });

  it('routes permit_learner to handlePermitLearner', () => {
    const d = handle('permit_learner', { cwd: tmp, toolName: 'Read', isMplActive: true });
    assert.equal(d.action, 'noop');
  });

  it('routes bash_timeout to handleBashTimeout', () => {
    const d = handle('bash_timeout', { cwd: tmp, toolName: 'Read', isMplActive: true });
    assert.equal(d.action, 'silent');
  });

  it('routes resource_risk to handleResourceRisk', () => {
    const d = handle('resource_risk', { cwd: tmp });
    assert.equal(d.action, 'report');
  });

  it('routes fallback_grep to handleFallbackGrep', () => {
    const d = handle('fallback_grep', { cwd: tmp, toolName: 'Bash', isMplActive: true });
    assert.equal(d.action, 'silent');
  });

  it('throws on unknown event', () => {
    assert.throws(() => handle('nonsense', {}), /unknown event/);
  });
});

// ============================================================================
// Symmetry guarantee — auto-permit and learner share the SAME veto
// ============================================================================

describe('classifyBashCommand symmetry across auto-permit and learner', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('every command auto-permit pass-throughs-with-veto, the learner skips', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    const vetoedCommands = [
      'git push --force origin main',
      'sudo rm /tmp/foo',
      'kubectl delete pod foo',
      'chmod 777 /etc/passwd',
      "echo 'x' > src/app.ts",
      'rm -rf docs/learnings',
    ];
    for (const cmd of vetoedCommands) {
      const ap = handleAutoPermit({
        cwd: tmp,
        toolName: 'Bash',
        toolInput: { command: cmd },
        isMplActive: true,
      });
      const pl = handlePermitLearner({
        cwd: tmp,
        toolName: 'Bash',
        toolInput: { command: cmd },
        isMplActive: true,
      });
      // auto-permit MUST NOT have returned `approve`.
      assert.notEqual(ap.action, 'approve', `auto-permit must not approve: ${cmd}`);
      // learner MUST be either veto-skip OR noop (never learn).
      assert.notEqual(pl.action, 'learn-bash-prefix', `learner must not persist: ${cmd}`);
      assert.notEqual(pl.action, 'learn-tool', `learner must not persist: ${cmd}`);
    }
  });
});
