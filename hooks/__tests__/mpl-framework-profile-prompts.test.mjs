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
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'i');
}

function topLevelSectionLines(markdown, heading) {
  const lines = markdown.split('\n');
  const out = [];
  let inSection = false;

  for (const line of lines) {
    if (line === heading) {
      if (inSection) break;
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) {
      break;
    }
    if (inSection) {
      out.push(line);
    }
  }

  return out;
}

function parseBacktickBlocks(markdown) {
  const blocks = [];
  let current = null;

  for (const line of markdown.split('\n')) {
    const header = line.match(/^`([^`]+)`$/);
    if (header) {
      current = { name: header[1], lines: [] };
      blocks.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  return blocks;
}

function parseBacktickListItems(block) {
  return block.lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^- `([^`]+)`$/)?.[1]?.trim())
    .filter(Boolean);
}

function parsePromptGuardLiterals(registry) {
  const literals = [];

  for (const block of parseBacktickBlocks(registry)) {
    if (block.name !== 'prompt_guard_literals') continue;
    for (const literal of parseBacktickListItems(block)) {
      if (literal.toLowerCase() !== 'none') {
        literals.push(literal);
      }
    }
  }

  return [...new Set(literals)];
}

function parseContractCategories(registry) {
  return topLevelSectionLines(registry, '## Profile Contract')
    .map((line) => line.match(/^### `([^`]+)`/)?.[1])
    .filter(Boolean);
}

function parseProfileSections(registry) {
  const sections = [];
  let current = null;

  for (const line of topLevelSectionLines(registry, '## Profiles')) {
    const heading = line.match(/^### (.+)$/)?.[1];
    if (heading) {
      current = { heading: heading.trim(), bodyLines: [] };
      sections.push(current);
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }

  return sections.map(({ heading, bodyLines }) => ({ heading, body: bodyLines.join('\n') }));
}

function parseProfileCategoryEntries(sections) {
  const entries = new Map(REQUIRED_PROFILE_CATEGORIES.map((category) => [category, []]));

  for (const section of sections) {
    for (const block of parseBacktickBlocks(section.body)) {
      if (!entries.has(block.name)) continue;
      const id = block.lines
        .map((line) => line.trim())
        .find((line) => line.startsWith('- `id`:'))
        ?.match(/^- `id`: `([^`]+)`/)?.[1];
      if (id) {
        entries.get(block.name).push({ section: section.heading, id });
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

  it('parses guard literals defensively', () => {
    const registry = [
      '`prompt_guard_literals`',
      '- `None`',
      '',
      '- `Tauri`',
      '- ` NONE `',
      '',
    ].join('\n');

    assert.deepEqual(parsePromptGuardLiterals(registry), ['Tauri']);
  });

  it('matches non-word-prefix guard literals with explicit token boundaries', () => {
    const scopedPackage = literalPattern('@scope/pkg');

    assert.equal(scopedPackage.test('load @scope/pkg profile'), true);
    assert.equal(scopedPackage.test('email@scope/pkg.com'), false);
    assert.equal('load @scope/pkg profile'.match(scopedPackage)?.[0], '@scope/pkg');
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
      .filter(({ body }) => {
        const block = parseBacktickBlocks(body).find(({ name }) => name === 'prompt_guard_literals');
        return !block || parseBacktickListItems(block).length === 0;
      })
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

  it('parses profile ids without relying on id-first ordering', () => {
    const entries = parseProfileCategoryEntries([
      {
        heading: 'Synthetic Build Tool',
        body: [
          '`build_tool_profiles`',
          '- `applies_when`: synthetic manifest',
          '- `id`: `synthetic-build-tool`',
          '',
        ].join('\n'),
      },
    ]);

    assert.deepEqual(entries.get('build_tool_profiles'), [
      { section: 'Synthetic Build Tool', id: 'synthetic-build-tool' },
    ]);
  });

  it('parses profile sections without crossing adjacent top-level headings', () => {
    const registry = [
      '## Profile Contract',
      '### `prompt_guard_literals`',
      '### `boundary_profiles`',
      '## Notes',
      '### `ignored_contract_category`',
      '## Profiles',
      '### Synthetic Framework',
      '`prompt_guard_literals`',
      '- `Synthetic`',
      '## Appendix',
      '### Ignored Appendix Profile',
      '`prompt_guard_literals`',
      '- `Appendix`',
      '',
    ].join('\n');

    assert.deepEqual(parseContractCategories(registry), ['prompt_guard_literals', 'boundary_profiles']);
    assert.deepEqual(parseProfileSections(registry), [
      {
        heading: 'Synthetic Framework',
        body: ['`prompt_guard_literals`', '- `Synthetic`'].join('\n'),
      },
    ]);
  });

  it('uses the first matching top-level section only', () => {
    const registry = [
      '## Profile Contract',
      '### `prompt_guard_literals`',
      '## Profile Contract',
      '### `ignored_duplicate`',
      '## Profiles',
      '',
    ].join('\n');

    assert.deepEqual(parseContractCategories(registry), ['prompt_guard_literals']);
  });
});

describe('Tauri platform constraint hardening (Exp22 R14 / #211)', () => {
  it('declares the three new Tauri platform constraint profiles', () => {
    const registry = readRepoFile(PROFILE_REGISTRY);
    // Each profile id is a load-bearing literal the decomposer / Phase 0
    // raw-scan path will look up. These ids must not regress out.
    assert.match(registry, /`id`: `tauri-rust-state-manage`/,
      'Tauri profile must declare tauri-rust-state-manage');
    assert.match(registry, /`id`: `tauri-v2-capability-coverage`/,
      'Tauri profile must declare tauri-v2-capability-coverage');
    assert.match(registry, /`id`: `tauri-conf-csp-null`/,
      'Tauri profile must declare tauri-conf-csp-null');
  });

  it('names the Builder::manage(T) rule against tauri::State<\'_, T>', () => {
    const registry = readRepoFile(PROFILE_REGISTRY);
    // The decomposer-facing constraint MUST mention both literals so the
    // Phase 0 raw-scan grep pattern stays anchored on the right tokens.
    assert.match(registry, /tauri::State<'_, T>/);
    assert.match(registry, /Builder::manage/);
    assert.match(registry, /\.manage\(/);
  });

  it('names the capability coverage requirement for #[tauri::command] / invoke()', () => {
    const registry = readRepoFile(PROFILE_REGISTRY);
    assert.match(registry, /#\[tauri::command\]/);
    assert.match(registry, /invoke\(/);
    assert.match(registry, /src-tauri\/capabilities\/\*\.json/);
    // The late finalize safety net (mpl-require-e2e-authenticity.mjs)
    // must still be referenced so the two layers stay coordinated.
    assert.match(registry, /mpl-require-e2e-authenticity\.mjs/);
  });

  it('names csp:null as development-only and requires release rationale', () => {
    const registry = readRepoFile(PROFILE_REGISTRY);
    assert.match(registry, /tauri\.conf\.json/);
    assert.match(registry, /csp[^\n]*null/i);
    assert.match(registry, /release/i);
  });
});
