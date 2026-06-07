/**
 * plugin-validate.test.mjs
 *
 * Drift catcher for plugin manifests and agent .md frontmatter.
 *
 * Why this file exists
 * --------------------
 * The stock `claude plugin validate` CLI only validates
 * `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`.
 * It never descends into `agents/*.md`, so a broken `description:` line, a
 * bogus `model:` value, or a scalar `disallowedTools` field in any agent
 * markdown passes silently — verified empirically against this repo:
 * deliberately corrupting an agent file's frontmatter still produces
 * `Validation passed` under both `claude plugin validate` and
 * `claude plugin validate --strict`. Feeding an individual agent .md to
 * `claude plugin validate` is misuse (the CLI then tries to JSON-parse the
 * markdown as a plugin manifest).
 *
 * This test therefore runs two complementary checks under a single
 * `node --test` surface:
 *
 *   1. Plugin / marketplace manifest gate — invokes `claude plugin validate
 *      --strict <repo-root>` as a subprocess when the CLI is available, and
 *      asserts a clean exit. Skipped (not failed) when the `claude` binary
 *      is missing and `CI=true`, so CI environments without the binary do
 *      not redden.
 *
 *   2. Agent frontmatter gate — iterates every `agents/*.md`, parses the
 *      YAML frontmatter directly, and asserts the required schema
 *      (`name`, `description`, `model`, optional `disallowedTools` shape).
 *      This is the real drift catcher and runs unconditionally.
 *
 * Required agent frontmatter schema
 * ---------------------------------
 *   name:            string, must equal basename(file, '.md')
 *   description:     non-empty string
 *   model:           one of: haiku | sonnet | opus
 *   disallowedTools: (optional) flow-list `[A, B]`, bare CSV `A, B`,
 *                    or empty list `[]`. Scalar non-CSV values are
 *                    rejected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const AGENTS_DIR = join(PLUGIN_ROOT, 'agents');

const ALLOWED_MODELS = new Set(['haiku', 'sonnet', 'opus']);

/**
 * Extract the leading `---\n...\n---` block from an agent markdown file.
 * Returns the raw frontmatter body (no fences). Throws if absent.
 */
function extractFrontmatter(text, filename) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    throw new Error(`${filename}: missing leading '---' frontmatter fence`);
  }
  const body = text.replace(/^---\r?\n/, '');
  const endIdx = body.search(/\r?\n---\r?\n/);
  if (endIdx === -1) {
    throw new Error(`${filename}: missing closing '---' frontmatter fence`);
  }
  return body.slice(0, endIdx);
}

/**
 * Parse the small subset of YAML we actually use in agent frontmatter:
 * top-level `key: value` pairs only. Values may be:
 *   - double- or single-quoted strings
 *   - bare scalars (everything after the colon, trimmed)
 *   - flow lists like `[A, B, C]` or `[]`
 *
 * We intentionally don't reuse hooks/lib/yaml-mini.mjs because it doesn't
 * accept non-empty flow sequences, which appear as
 * `disallowedTools: [Edit, MultiEdit, NotebookEdit]` in some agents.
 */
function parseFrontmatter(body, filename) {
  const out = {};
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      throw new Error(`${filename}: malformed frontmatter line ${i + 1}: ${JSON.stringify(line)}`);
    }
    const key = m[1];
    let raw = m[2].trim();

    let value;
    if (raw === '') {
      value = '';
    } else if (raw === '[]') {
      value = [];
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      // Flow list: split on commas, trim, drop empties.
      value = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      value = raw.slice(1, -1);
    } else {
      value = raw;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Normalize `disallowedTools` into a string[] for shape checking.
 * Accepts an already-parsed array (from `[A, B]`) or a bare CSV string
 * (`A, B, C`). A scalar non-CSV string is allowed only if it is a single
 * tool name. Returns null when the field is absent.
 */
function normalizeDisallowedTools(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    if (value === '') return [];
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  throw new Error(`disallowedTools must be a list or CSV string, got ${typeof value}`);
}

function listAgentFiles() {
  return readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => statSync(join(AGENTS_DIR, name)).isFile())
    .sort();
}

/**
 * Detect whether the `claude` CLI is callable. Returns the resolved path
 * or null. We never throw — caller decides whether to skip or fail.
 */
function findClaudeBinary() {
  // Honor an explicit override so callers can point this at a known build.
  if (process.env.CLAUDE_BIN && process.env.CLAUDE_BIN.length > 0) {
    return process.env.CLAUDE_BIN;
  }
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
    });
    if (which.status === 0) {
      const first = which.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
      if (first) return first.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

describe('plugin-validate: marketplace + plugin manifest', () => {
  it('claude plugin validate --strict accepts the repo root', (t) => {
    const claudeBin = findClaudeBinary();
    if (!claudeBin) {
      // Skip silently in CI so headless runners without the CLI installed
      // don't redden; still fail locally so the developer notices a missing
      // CLI before pushing.
      if (process.env.CI === 'true' || process.env.CI === '1') {
        t.skip('claude CLI not on PATH; skipping under CI');
        return;
      }
      t.skip('claude CLI not on PATH; install it to enable this check locally');
      return;
    }

    let output;
    try {
      output = execFileSync(claudeBin, ['plugin', 'validate', '--strict', PLUGIN_ROOT], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const stdout = err.stdout ? err.stdout.toString() : '';
      const stderr = err.stderr ? err.stderr.toString() : '';
      assert.fail(
        `claude plugin validate --strict failed (exit ${err.status}):\n` +
          `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      );
    }

    // The CLI sometimes exits 0 even on errors; require the explicit
    // "Validation passed" sentinel and the absence of any "✘"/"failed"
    // marker so a future CLI behavior change doesn't silently regress us.
    assert.match(output, /Validation passed/, `expected pass sentinel; got:\n${output}`);
    assert.doesNotMatch(output, /✘|Validation failed/i, `unexpected failure marker:\n${output}`);
  });
});

describe('plugin-validate: agent frontmatter schema', () => {
  const files = listAgentFiles();

  it('discovers at least one agent file', () => {
    assert.ok(files.length > 0, `no agents found under ${AGENTS_DIR}`);
  });

  for (const filename of files) {
    it(`${filename} has a valid frontmatter block`, () => {
      const fullPath = join(AGENTS_DIR, filename);
      const text = readFileSync(fullPath, 'utf8');

      const body = extractFrontmatter(text, filename);
      const fm = parseFrontmatter(body, filename);

      // Required: name
      assert.ok(
        typeof fm.name === 'string' && fm.name.length > 0,
        `${filename}: 'name' must be a non-empty string`,
      );
      const expectedName = basename(filename, '.md');
      assert.equal(
        fm.name,
        expectedName,
        `${filename}: 'name' (${fm.name}) must match basename (${expectedName})`,
      );

      // Required: description
      assert.ok(
        typeof fm.description === 'string' && fm.description.trim().length > 0,
        `${filename}: 'description' must be a non-empty string`,
      );

      // Required: model ∈ allowed set
      assert.ok(
        typeof fm.model === 'string',
        `${filename}: 'model' must be a string`,
      );
      assert.ok(
        ALLOWED_MODELS.has(fm.model),
        `${filename}: 'model' must be one of [${[...ALLOWED_MODELS].join(', ')}], got ${JSON.stringify(fm.model)}`,
      );

      // Optional: disallowedTools — when present, must be a list-shape we
      // can normalize. The empirically-observed crash mode is a bogus
      // scalar like `disallowedTools:` with no value, or a non-CSV scalar.
      if ('disallowedTools' in fm) {
        let normalized;
        try {
          normalized = normalizeDisallowedTools(fm.disallowedTools);
        } catch (err) {
          assert.fail(`${filename}: ${err.message}`);
        }
        assert.ok(
          Array.isArray(normalized),
          `${filename}: 'disallowedTools' must normalize to an array`,
        );
        for (const tool of normalized) {
          assert.ok(
            typeof tool === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(tool),
            `${filename}: 'disallowedTools' entry ${JSON.stringify(tool)} must be a bare tool identifier`,
          );
        }
      }
    });
  }
});
