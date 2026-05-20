import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const PROFILE_REGISTRY = 'commands/references/framework-profiles.md';
const SCAN_ROOTS = ['agents', 'commands'];
const FORBIDDEN_RUNTIME_LITERALS = [
  /\bTauri\b/i,
  /\bsrc-tauri\b/i,
  /\bElectron\b/i,
  /\bNext\.js\b/i,
  /\bnext\.config\b/i,
  /\bFastAPI\b/i,
  /\bReact Native\b/i,
  /\bPlaywright\b/i,
  /\bCypress\b/i,
  /\btauri-driver\b/i,
];

function posix(path) {
  return path.split(sep).join('/');
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
      out.push(posix(relative(process.cwd(), full)));
    }
  }
  return out;
}

describe('framework-specific prompt literals', () => {
  it('keeps framework policy literals in the profile registry, not runtime prompts', () => {
    const files = SCAN_ROOTS.flatMap((root) => walkMarkdown(join(process.cwd(), root)))
      .filter((file) => file !== PROFILE_REGISTRY);

    const hits = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, idx) => {
        for (const pattern of FORBIDDEN_RUNTIME_LITERALS) {
          if (pattern.test(line)) {
            hits.push(`${file}:${idx + 1}: ${line.trim()}`);
            break;
          }
        }
      });
    }

    assert.deepEqual(hits, [], `Move framework-specific prompt rules to ${PROFILE_REGISTRY}:\n${hits.join('\n')}`);
  });
});
