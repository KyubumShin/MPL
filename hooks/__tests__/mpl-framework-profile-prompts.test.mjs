import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const PROFILE_REGISTRY = 'commands/references/framework-profiles.md';
const SCAN_ROOTS = ['agents', 'commands'];
const REQUIRED_PROFILE_CATEGORIES = [
  'boundary_profiles',
  'platform_constraint_profiles',
  'framework_convention_profiles',
  'launch_smoke_profiles',
  'build_tool_profiles',
  'resource_risk_profiles',
  'e2e_runner_profiles',
];

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..');

function posix(path) {
  return path.split(sep).join('/');
}

function repoPath(...segments) {
  return join(REPO_ROOT, ...segments);
}

function readRepoFile(path) {
  return readFileSync(repoPath(path), 'utf-8');
}

function walkMarkdown(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.endsWith('.md')) {
      out.push(posix(relative(REPO_ROOT, full)));
    }
  }
  return out;
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalPattern(literal) {
  const escaped = escapeRegExp(literal).replace(/\\ /g, '\\s+');
  const startBoundary = /^[A-Za-z0-9_]/.test(literal) ? '\\b' : '';
  const endBoundary = /[A-Za-z0-9_]$/.test(literal) ? '\\b' : '';
  return new RegExp(`${startBoundary}${escaped}${endBoundary}`, 'i');
}

function parsePromptGuardLiterals(registry) {
  const literals = [];
  const blockPattern = /^`prompt_guard_literals`\n((?:- `[^`]+`\n?)+)/gm;
  let match;

  while ((match = blockPattern.exec(registry)) !== null) {
    for (const line of match[1].trim().split('\n')) {
      const literal = line.match(/^- `([^`]+)`$/)?.[1];
      if (literal && literal !== 'none') {
        literals.push(literal);
      }
    }
  }

  return [...new Set(literals)];
}

function parseContractCategories(registry) {
  const contract = registry.match(/## Profile Contract\n([\s\S]+?)\n## Profiles/)?.[1] ?? '';
  return [...contract.matchAll(/^### `([^`]+)`/gm)].map((match) => match[1]);
}

function parseProfileSections(registry) {
  const profiles = registry.match(/## Profiles\n([\s\S]+)$/)?.[1] ?? '';
  return profiles
    .split(/^### /m)
    .slice(1)
    .map((section) => {
      const [heading, ...body] = section.split('\n');
      return { heading: heading.trim(), body: body.join('\n') };
    });
}

function parseProfileCategoryEntries(sections) {
  const entries = new Map(REQUIRED_PROFILE_CATEGORIES.map((category) => [category, []]));

  for (const section of sections) {
    const blocks = [...section.body.matchAll(/^`([^`]+)`\n([\s\S]*?)(?=\n`[^`]+`\n|\n### |\s*$)/gm)];
    for (const [, category, body] of blocks) {
      if (!entries.has(category)) continue;
      const id = body.match(/^- `id`: `([^`]+)`/m)?.[1];
      if (id) {
        entries.get(category).push({ section: section.heading, id });
      }
    }
  }

  return entries;
}

describe('framework-specific prompt literals', () => {
  it('keeps framework policy literals in the profile registry, not runtime prompts', () => {
    const guardLiterals = parsePromptGuardLiterals(readRepoFile(PROFILE_REGISTRY));
    assert.ok(
      guardLiterals.length > 0,
      `${PROFILE_REGISTRY} must define at least one concrete prompt_guard_literals entry`,
    );
    const forbiddenRuntimeLiterals = guardLiterals.map(literalPattern);
    const files = SCAN_ROOTS.flatMap((root) => walkMarkdown(repoPath(root)))
      .filter((file) => file !== PROFILE_REGISTRY);

    const hits = [];
    for (const file of files) {
      const lines = readRepoFile(file).split('\n');
      lines.forEach((line, idx) => {
        for (const pattern of forbiddenRuntimeLiterals) {
          if (pattern.test(line)) {
            hits.push(`${file}:${idx + 1}: ${line.trim()}`);
            break;
          }
        }
      });
    }

    assert.deepEqual(hits, [], `Move framework-specific prompt rules to ${PROFILE_REGISTRY}:\n${hits.join('\n')}`);
  });

  it('keeps the framework profile registry structurally complete', () => {
    const registry = readRepoFile(PROFILE_REGISTRY);
    const contractCategories = parseContractCategories(registry);
    const profileSections = parseProfileSections(registry);
    const profileEntries = parseProfileCategoryEntries(profileSections);

    assert.deepEqual(
      contractCategories,
      ['prompt_guard_literals', ...REQUIRED_PROFILE_CATEGORIES],
      'Profile Contract must declare the prompt guard and all supported profile categories in order',
    );
    assert.ok(profileSections.length > 0, 'Profile registry must contain at least one profile section');

    const missingGuards = profileSections
      .filter(({ body }) => !/^`prompt_guard_literals`\n(?:- `[^`]+`\n)+/m.test(body))
      .map(({ heading }) => heading);
    assert.deepEqual(missingGuards, [], `Every profile section needs prompt_guard_literals:\n${missingGuards.join('\n')}`);

    const emptyCategories = [];
    for (const category of REQUIRED_PROFILE_CATEGORIES) {
      if (profileEntries.get(category).length === 0) {
        emptyCategories.push(category);
      }
    }
    assert.deepEqual(emptyCategories, [], `Every supported profile category needs at least one registry entry:\n${emptyCategories.join('\n')}`);
  });
});
