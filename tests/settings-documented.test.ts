import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every setting the server reads is documented where an operator will look.
 *
 * Three settings shipped undocumented in one release, and the row describing a
 * fourth had gone stale and was actively wrong — it still said
 * `DOSSIER_LOCAL_CLI` took a single CLI after it began taking a list. Config
 * nobody can find is config nobody uses, and a doc row that contradicts the
 * code is worse than a missing one: it is followed.
 *
 * Derived from the Zod schema rather than a hand-kept list, so adding a setting
 * fails here until it is written down.
 */
describe('documented settings', () => {
  it('setup.md names every variable the env schema declares', () => {
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const docs = readFileSync(new URL('../docs/setup.md', import.meta.url), 'utf8');

    // Two-space indent is the schema's own object level, which keeps this from
    // matching a variable merely mentioned in a comment.
    const declared = [
      ...new Set(
        [...src.matchAll(/^ {2}(DOSSIER_[A-Z_]+|[A-Z]+_API_KEY|VERTEX_[A-Z]+):/gm)].map((m) => m[1]!),
      ),
    ];
    expect(declared.length, 'the schema should declare a good few').toBeGreaterThan(20);

    // Word-boundary, not `includes`. A substring check passes when the docs
    // name a LONGER variable that merely starts the same way, which is exactly
    // how the first version of this test passed its own mutation: renaming the
    // documented row to `DOSSIER_FREE_LANE_MAXX` still satisfied `includes`.
    const missing = declared.filter((v) => !new RegExp(`\\b${v}\\b`).test(docs));
    expect(missing, `undocumented in docs/setup.md: ${missing.join(', ')}`).toEqual([]);
  });
});
