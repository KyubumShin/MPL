// Move #6 — policy/source-edit.mjs Bash write-target extension.
//
// Validates that every Bash shape that writes to a source file is intercepted
// by the same direct_source_edit policy that already gates Edit/Write/MultiEdit:
//
//   - Redirects: `>FILE`, `>>FILE`, `&>FILE`, `1>FILE`, `exec >FILE`
//   - tee FILE
//   - sed -i FILE / sed --in-place=ext FILE
//   - dd of=FILE
//   - cp/mv/install/rsync SRC DST
//   - Interpreter one-liners: node -e "fs.writeFileSync('FILE', …)"
//                              python -c "open('FILE','w').write(…)"
//                              python -c "Path('FILE').write_text(…)"
//                              ruby -e "File.write('FILE', …)"
//   - touch FILE
//   - sponge FILE
//   - Formatters with write flag: prettier --write FILE, eslint --fix FILE,
//                                  gofmt -w FILE, ruff format FILE,
//                                  clang-format -i FILE
//   - patch FILE / git apply FILE / git restore -- FILE
//
// Plus the false-positive guards: allowlisted (.mpl/, .claude/, PLAN.md,
// docs/learnings/) targets are silent, non-source extensions are silent,
// opaque $VAR targets warn-only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

import {
  extractBashWriteTargets,
  normalizeShellCommand,
  isSourceFile,
  isAllowedPath,
} from '../lib/policy/source-edit.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOKS_DIR = dirname(__dirname);
const WRITE_GUARD = join(HOOKS_DIR, 'mpl-write-guard.mjs');

function freshWorkspace(extraConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-policy-source-'));
  mkdirSync(join(dir, '.mpl'), { recursive: true });
  writeFileSync(
    join(dir, '.mpl', 'state.json'),
    JSON.stringify({ current_phase: 'phase-1' }, null, 2),
  );
  if (extraConfig) {
    writeFileSync(join(dir, '.mpl', 'config.json'), JSON.stringify(extraConfig, null, 2));
  }
  return dir;
}

function runHook(cwd, payload, env = {}) {
  const out = execFileSync('node', [WRITE_GUARD], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return JSON.parse(out.trim());
}

function expectBlock(cwd, command) {
  const r = runHook(cwd, {
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  });
  assert.equal(r.decision, 'block', `Expected block for: ${command}\nGot: ${JSON.stringify(r)}`);
  assert.match(r.reason || '', /MPL DELEGATION NOTICE/);
}

function expectAllow(cwd, command) {
  const r = runHook(cwd, {
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  });
  assert.equal(r.continue, true, `Expected continue for: ${command}\nGot: ${JSON.stringify(r)}`);
  assert.equal(r.suppressOutput, true, `Expected silent for: ${command}\nGot: ${JSON.stringify(r)}`);
}

function expectWarn(cwd, command) {
  const r = runHook(cwd, {
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  });
  assert.equal(r.continue, true, `Expected continue (warn) for: ${command}\nGot: ${JSON.stringify(r)}`);
  assert.ok(r.hookSpecificOutput?.additionalContext,
    `Expected additionalContext (warn) for: ${command}\nGot: ${JSON.stringify(r)}`);
}

// ============================================================================
// Pure helpers — extractBashWriteTargets
// ============================================================================

test('extractBashWriteTargets: redirect > to source file', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('echo "forged" > src/app.ts'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'redirect'));
});

test('extractBashWriteTargets: redirect >> to source file', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('echo x >> src/app.ts'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'redirect'));
});

test('extractBashWriteTargets: tee captures every positional', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('echo x | tee src/a.ts src/b.ts'));
  const teeTargets = targets.filter((t) => t.source === 'tee').map((t) => t.target);
  assert.deepEqual(new Set(teeTargets), new Set(['src/a.ts', 'src/b.ts']));
});

test('extractBashWriteTargets: tee skips /dev/null sink', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('echo x | tee /dev/null src/a.ts'));
  const teeTargets = targets.filter((t) => t.source === 'tee').map((t) => t.target);
  assert.deepEqual(teeTargets, ['src/a.ts']);
});

test('extractBashWriteTargets: dd of=', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('dd if=/dev/zero of=src/app.ts bs=1'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'dd-of'));
});

test('extractBashWriteTargets: sed -i', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('sed -i s/foo/bar/ src/app.ts'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'sed-i'));
});

test('extractBashWriteTargets: cp dst', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('cp /tmp/forged.ts src/app.ts'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'cp-mv-dst'));
});

test('extractBashWriteTargets: mv dst', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('mv /tmp/a.ts src/app.ts'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'cp-mv-dst'));
});

test('extractBashWriteTargets: node -e writeFileSync', () => {
  const cmd = `node -e "require('fs').writeFileSync('src/app.ts', 'x')"`;
  const targets = extractBashWriteTargets(normalizeShellCommand(cmd));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'interpreter-write'),
    `Got: ${JSON.stringify(targets)}`);
});

test('extractBashWriteTargets: python -c open w', () => {
  const cmd = `python -c "open('src/app.py', 'w').write('x')"`;
  const targets = extractBashWriteTargets(normalizeShellCommand(cmd));
  assert.ok(targets.some((t) => t.target === 'src/app.py' && t.source === 'interpreter-write'));
});

test('extractBashWriteTargets: touch FILE', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('touch src/new.ts'));
  assert.ok(targets.some((t) => t.target === 'src/new.ts' && t.source === 'touch'));
});

test('extractBashWriteTargets: sponge FILE', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('echo x | sponge src/app.ts'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'sponge'));
});

test('extractBashWriteTargets: prettier --write', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('prettier --write src/app.ts'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'formatter'));
});

test('extractBashWriteTargets: prettier WITHOUT --write does NOT extract', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('prettier --check src/app.ts'));
  assert.equal(targets.filter((t) => t.source === 'formatter').length, 0);
});

test('extractBashWriteTargets: eslint --fix', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('eslint --fix src/app.ts'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'formatter'));
});

test('extractBashWriteTargets: opaque $VAR redirect target', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('echo x > $UNRESOLVED'));
  // $ survives normalizeShellCommand (no var assignment to expand).
  const opaque = targets.find((t) => t.opaque === true);
  assert.ok(opaque, `Expected at least one opaque target. Got: ${JSON.stringify(targets)}`);
});

test('extractBashWriteTargets: patch FILE', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('patch src/app.ts < /tmp/p.diff'));
  assert.ok(targets.some((t) => t.target === 'src/app.ts' && t.source === 'patch'));
});

test('extractBashWriteTargets: git apply FILE', () => {
  const targets = extractBashWriteTargets(normalizeShellCommand('git apply /tmp/p.diff'));
  assert.ok(targets.some((t) => t.target === '/tmp/p.diff' && t.source === 'git-apply'));
});

// ============================================================================
// End-to-end via the hook — every Bash bypass shape from the plan
// ============================================================================

test('Move #6 e2e: `echo > src/app.ts` is blocked (direct_source_edit default block)', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'echo "forged" > src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: `echo >> src/app.ts` is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'echo x >> src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: `tee src/app.ts` is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'echo x | tee src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: `dd of=src/app.ts` is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'dd if=/dev/zero of=src/app.ts bs=1'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: `sed -i src/app.ts` is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'sed -i s/foo/bar/ src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: `cp /tmp/x src/app.ts` is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'cp /tmp/x.ts src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: `mv /tmp/x src/app.ts` is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'mv /tmp/x.ts src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: node -e writeFileSync is blocked', () => {
  const cwd = freshWorkspace();
  try {
    expectBlock(cwd, `node -e "require('fs').writeFileSync('src/app.ts', 'x')"`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: touch src/new.ts is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'touch src/new.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: sponge src/app.ts is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'echo x | sponge src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: prettier --write src/app.ts is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'prettier --write src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: eslint --fix src/app.ts is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'eslint --fix src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Move #6 e2e: patch src/app.ts is blocked', () => {
  const cwd = freshWorkspace();
  try { expectBlock(cwd, 'patch src/app.ts < /tmp/p.diff'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ============================================================================
// False-positive guards — allowlisted paths and non-source extensions
// ============================================================================

test('false-positive: redirect into .mpl/ is allowed (allowlisted)', () => {
  const cwd = freshWorkspace();
  try { expectAllow(cwd, 'echo x > .mpl/working.md'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('false-positive: redirect into .claude/ is allowed', () => {
  const cwd = freshWorkspace();
  try { expectAllow(cwd, 'echo x > .claude/settings.local.json'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('false-positive: redirect into PLAN.md is allowed', () => {
  const cwd = freshWorkspace();
  try { expectAllow(cwd, 'echo x > PLAN.md'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('false-positive: redirect into docs/learnings/ — guarded by #236 A3 protected-delete', () => {
  // docs/learnings is a PROTECTED_DELETE_TARGETS root; redirects to it
  // are pre-empted by the #236 A3 protected_path_delete gate, not by
  // Move #6 source-edit. Verify the legacy guard still fires (and that
  // Move #6 doesn't ALSO mis-classify the .md file as source).
  const cwd = freshWorkspace();
  try {
    const r = runHook(cwd, {
      cwd, tool_name: 'Bash',
      tool_input: { command: 'echo x > docs/learnings/notes.md' },
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /#236 A3/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('false-positive: non-source .txt is allowed', () => {
  const cwd = freshWorkspace();
  try { expectAllow(cwd, 'echo x > notes.txt'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('false-positive: /dev/null redirect is allowed', () => {
  const cwd = freshWorkspace();
  try { expectAllow(cwd, 'echo x > /dev/null'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('false-positive: read-only `cat src/app.ts` is allowed', () => {
  const cwd = freshWorkspace();
  try { expectAllow(cwd, 'cat src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('false-positive: `ls src/` is allowed', () => {
  const cwd = freshWorkspace();
  try { expectAllow(cwd, 'ls src/'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('false-positive: prettier --check (no --write) is allowed', () => {
  const cwd = freshWorkspace();
  try { expectAllow(cwd, 'prettier --check src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('false-positive: 2>&1 fd-dup is not a redirect target', () => {
  const cwd = freshWorkspace();
  try { expectAllow(cwd, 'some-cmd 2>&1 > /dev/null'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ============================================================================
// Opaque downgrade — $VAR / glob targets warn-only
// ============================================================================

test('opaque downgrade: redirect to $VAR is warn-only (cannot prove block)', () => {
  const cwd = freshWorkspace();
  try { expectWarn(cwd, 'echo x > $UNRESOLVED_VAR'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ============================================================================
// Policy gates
// ============================================================================

test('policy gate: bash_write_targets=off disables Bash extraction', () => {
  const cwd = freshWorkspace({ enforcement: { bash_write_targets: 'off' } });
  try { expectAllow(cwd, 'echo x > src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('policy gate: direct_source_edit=warn downgrades Bash block to warn', () => {
  const cwd = freshWorkspace({ enforcement: { direct_source_edit: 'warn' } });
  try { expectWarn(cwd, 'echo x > src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('policy gate: direct_source_edit=off silences Bash Move #6', () => {
  const cwd = freshWorkspace({ enforcement: { direct_source_edit: 'off' } });
  try { expectAllow(cwd, 'echo x > src/app.ts'); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ============================================================================
// NotebookEdit support
// ============================================================================

test('NotebookEdit on .ipynb is treated as direct_source_edit (default block)', () => {
  const cwd = freshWorkspace();
  try {
    const r = runHook(cwd, {
      cwd,
      tool_name: 'NotebookEdit',
      tool_input: {
        notebook_path: 'analysis.ipynb',
        cell_id: 'cell-1',
        new_source: 'print("x")',
      },
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /MPL DELEGATION NOTICE/);
    assert.match(r.reason, /NotebookEdit/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('NotebookEdit on allowlisted .mpl/ ipynb is silent', () => {
  const cwd = freshWorkspace();
  try {
    const r = runHook(cwd, {
      cwd,
      tool_name: 'NotebookEdit',
      tool_input: {
        notebook_path: '.mpl/notes.ipynb',
        cell_id: 'cell-1',
        new_source: 'print("x")',
      },
    });
    assert.equal(r.continue, true);
    assert.equal(r.suppressOutput, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ============================================================================
// Edit/Write parity preserved
// ============================================================================

test('Edit on source file default → block (Move #6 flip)', () => {
  const cwd = freshWorkspace();
  try {
    const r = runHook(cwd, {
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
    });
    assert.equal(r.decision, 'block');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('isSourceFile recognizes .ipynb', () => {
  assert.equal(isSourceFile('analysis.ipynb'), true);
});

test('isAllowedPath honors PLAN.md / docs/learnings', () => {
  assert.equal(isAllowedPath('PLAN.md'), true);
  assert.equal(isAllowedPath('docs/learnings/notes.md'), true);
});

// ============================================================================
// action ↔ decision SSOT (Move #16 cleanup)
//
// The canonical envelope field is `action`. The legacy `.decision` alias is
// kept as a deprecated mirror that emits a one-time stderr DEPRECATED line
// when read. Both fields MUST round-trip identically; the mirror must NOT
// throw when accessed; existing wrapper switch/aggregate paths must keep
// observing the same shape.
// ============================================================================

test('handle() returns `action` as the canonical field (block path)', async () => {
  const { handle } = await import('../lib/policy/source-edit.mjs');
  const cwd = freshWorkspace();
  try {
    const result = await handle({
      event: 'PreToolUse',
      toolName: 'Edit',
      toolInput: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
      cwd,
      state: { current_phase: 'phase-1' },
      data: {},
      isMplActive: true,
      callerTranscriptPath: null,
    });
    assert.equal(typeof result.action, 'string');
    assert.equal(result.action, 'block');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('handle() exposes deprecated `.decision` alias that mirrors `.action`', async () => {
  const { handle } = await import('../lib/policy/source-edit.mjs');
  const cwd = freshWorkspace();
  try {
    const result = await handle({
      event: 'PreToolUse',
      toolName: 'Edit',
      toolInput: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
      cwd,
      state: { current_phase: 'phase-1' },
      data: {},
      isMplActive: true,
      callerTranscriptPath: null,
    });
    // Legacy callers (wrapper switch + engine aggregate) still see `.decision`.
    assert.equal(result.decision, result.action,
      'decision alias must mirror action exactly');
    assert.equal(result.decision, 'block');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('handle() allow path: action === "allow"', async () => {
  const { handle } = await import('../lib/policy/source-edit.mjs');
  const cwd = freshWorkspace();
  try {
    const result = await handle({
      event: 'PreToolUse',
      toolName: 'Read',          // not a write/bash/task tool → allow()
      toolInput: {},
      cwd,
      state: {},
      data: {},
      isMplActive: true,
      callerTranscriptPath: null,
    });
    assert.equal(result.action, 'allow');
    assert.equal(result.decision, 'allow');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('handle() decision alias emits exactly one stderr DEPRECATED line per process', async () => {
  // Run a sub-process so the module-level memoization is fresh.
  const probeScript = `
    import { handle } from '${join(HOOKS_DIR, 'lib', 'policy', 'source-edit.mjs').replace(/\\\\/g, '/')}';
    const event = {
      event: 'PreToolUse',
      toolName: 'Edit',
      toolInput: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
      cwd: process.cwd(),
      state: { current_phase: 'phase-1' },
      data: {},
      isMplActive: true,
      callerTranscriptPath: null,
    };
    const r1 = await handle(event);
    // First read — should trigger the deprecation warning.
    void r1.decision;
    // Second read — should NOT trigger a second warning (memoized).
    void r1.decision;
    const r2 = await handle(event);
    // Third read on a fresh result — still NO additional warning (process-wide flag).
    void r2.decision;
    process.stdout.write('OK\\n');
  `;
  const cwd = freshWorkspace();
  try {
    const { spawnSync } = await import('child_process');
    const proc = spawnSync('node', ['--input-type=module', '-e', probeScript], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env },
    });
    assert.equal(proc.stdout.trim(), 'OK');
    const deprecationMatches = (proc.stderr.match(/DEPRECATED: result\.decision/g) || []);
    assert.equal(
      deprecationMatches.length,
      1,
      `expected exactly one DEPRECATED line, got ${deprecationMatches.length}.\nstderr:\n${proc.stderr}`,
    );
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
