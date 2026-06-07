import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../lib/yaml-mini.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');

describe('yaml-mini parser', () => {
  it('parses block-style sequence into an array', () => {
    const out = parseYaml('k:\n  - a\n  - b\n');
    assert.deepEqual(out.k, ['a', 'b']);
  });

  it('does not parse flow-style sequence (documents parser limit)', () => {
    // The single-file 120-LOC parser intentionally does not support flow
    // sequences. parseScalar falls through to the bare-string return — the
    // result is the literal text, not an array. This test documents that
    // limit so flow-style does not silently sneak back into the config.
    const out = parseYaml("k: ['a','b']");
    assert.equal(typeof out.k, 'string');
    assert.notDeepEqual(out.k, ['a', 'b']);
  });

  it('round-trips mpl.config.yaml with block-style sentinel filters', () => {
    const text = readFileSync(join(ROOT, 'mpl.config.yaml'), 'utf-8');
    const result = parseYaml(text);
    assert.ok(result.observability, 'observability key must parse');
    assert.ok(result.observability.sentinels, 'sentinels key must parse');
    const filter = result.observability.sentinels.subagent_type_filter;
    assert.ok(filter, 'subagent_type_filter must parse');
    assert.ok(Array.isArray(filter.s0), 's0 must be an array (yaml-mini block style)');
    assert.equal(filter.s0.length, 4);
    assert.ok(Array.isArray(filter.s1));
    assert.equal(filter.s1.length, 2);
    assert.ok(Array.isArray(filter.s3));
    assert.equal(filter.s3.length, 2);
  });
});
