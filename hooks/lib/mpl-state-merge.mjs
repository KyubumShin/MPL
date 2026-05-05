/**
 * Pure deep-merge helper for `state.json` patches.
 *
 * Lives in its own module so migration scripts under `hooks/lib/migrations/`
 * can import it without forming a cycle with `mpl-state.mjs` (which itself
 * imports the migration registry). `mpl-state.mjs` re-exports `deepMerge`
 * so existing consumers keep working.
 *
 * Behavior contract:
 *   - Plain objects → recursive merge.
 *   - Arrays → replaced wholesale (not concatenated).
 *   - `__proto__` / `constructor` / `prototype` keys → ignored
 *     (prototype-pollution guard).
 *   - Inputs are not mutated.
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;

    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
