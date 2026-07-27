import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  claimConvergence,
  CONVERGENCE_IS_NOT_CORROBORATION,
  type ProviderClaimSet,
} from './convergence.js';
import { sourceOverlapProfile } from './overlap.js';
import { member } from './fixtures.js';

/**
 * Source overlap and claim convergence measure different objects, and the whole
 * point of these tests is that neither number can stand in for the other.
 *
 * Two backends citing the same *page* is a fact about the web. Two backends
 * stating the same *conclusion* is the corroboration trap. The fixtures below
 * drive the two apart in both directions, because a test where they happen to
 * agree proves nothing about whether they can be confused.
 */

const claimSet = (provider: string, texts: readonly string[], urls: readonly string[] = []): ProviderClaimSet => ({
  provider,
  claims: texts.map((text) => ({ provider, text, urls: [...urls] })),
});

describe('the two are structurally incompatible (COMB-16)', () => {
  it('takes different inputs, so neither function accepts the other argument', () => {
    const members = [member('a', ['https://x.com/1']), member('b', ['https://x.com/1'])];
    const claims = [claimSet('a', ['the figure rose to 28.6 percent in March'])];

    // The enforcement is the type system, and this asserts the shapes really do
    // differ at runtime rather than merely being named differently. A member
    // has runs; a claim set has claims. Neither has the other's key.
    expect(members[0]).toHaveProperty('runs');
    expect(members[0]).not.toHaveProperty('claims');
    expect(claims[0]).toHaveProperty('claims');
    expect(claims[0]).not.toHaveProperty('runs');
  });

  it('returns differently shaped results, so neither can be read as the other', () => {
    const overlap = sourceOverlapProfile([member('a', ['https://x.com/1'])]);
    const convergence = claimConvergence([claimSet('a', ['a claim'])]);
    expect(overlap).toHaveProperty('pairs');
    expect(overlap).toHaveProperty('robustness');
    expect(overlap).not.toHaveProperty('candidates');
    expect(convergence).toHaveProperty('candidates');
    expect(convergence).not.toHaveProperty('pairs');
    expect(convergence).not.toHaveProperty('robustness');
  });

  it('keeps them in separate modules with no import between them', () => {
    // A convention a caller can bypass is not enforcement, but a module that
    // cannot reach the other is. Read the source rather than trusting review.
    //
    // Only the IMPORT lines are checked, deliberately. Each file names the
    // other in prose to explain the distinction, and that comment is the most
    // valuable line in either file: forbidding the words would delete the
    // explanation while leaving the coupling this actually guards against.
    // Asserted on the imported SYMBOLS, not on the module path. Both files
    // legitimately reach `corroborate.ts`, which holds the domain helper and
    // the claim matcher side by side; what must never happen is one importing
    // the other's measure.
    const importBlock = (file: string): string => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      // The import STATEMENTS only. A doc comment naming the other measure is
      // the explanation, not the coupling, and must not fail this.
      return [...src.matchAll(/^import[\s\S]*?from\s+'[^']+';/gm)].map((m) => m[0]).join('\n');
    };

    expect(importBlock('./overlap.ts')).not.toMatch(/\bfindConvergence\b/);
    expect(importBlock('./overlap.ts')).not.toMatch(/from '\.\/convergence\.js'/);
    expect(importBlock('./convergence.ts')).not.toMatch(/\bsourceOverlapProfile\b/);
    expect(importBlock('./convergence.ts')).not.toMatch(/from '\.\/(overlap|merge|member)\.js'/);
  });
});

describe('same sources, no shared conclusion (COMB-17)', () => {
  // Both members read exactly the same three pages and drew unrelated
  // conclusions from them. Source overlap is total; convergence is nothing.
  const urls = ['https://example.org/a', 'https://example.org/b', 'https://example.org/c'];

  it('reports complete source overlap', () => {
    const profile = sourceOverlapProfile([member('a', urls), member('b', urls)]);
    expect(profile.pairs[0]!.urlJaccard).toBe(1);
  });

  it('and reports no claim convergence at all', () => {
    const convergence = claimConvergence([
      claimSet('a', ['Quarterly revenue reached 4.2 billion dollars in the June period'], urls),
      claimSet('b', ['Headcount fell by roughly nine hundred staff across European offices'], urls),
    ]);
    expect(convergence.candidates).toEqual([]);
  });

  it('which is the whole point: identical reading is not identical conclusions', () => {
    const profile = sourceOverlapProfile([member('a', urls), member('b', urls)]);
    const convergence = claimConvergence([
      claimSet('a', ['Quarterly revenue reached 4.2 billion dollars in the June period'], urls),
      claimSet('b', ['Headcount fell by roughly nine hundred staff across European offices'], urls),
    ]);
    expect(profile.pairs[0]!.urlJaccard).toBe(1);
    expect(convergence.candidates).toHaveLength(0);
  });
});

describe('no shared source, one shared conclusion (COMB-18)', () => {
  // The mirror case, and the more dangerous one: two backends that read nothing
  // in common still state the same thing. That is convergence with zero source
  // overlap, and a metric that conflated the two would report it as zero.
  const claim = 'The regulator confirmed the merger review will extend into the fourth quarter of 2026';

  it('reports no source overlap', () => {
    const profile = sourceOverlapProfile([
      member('a', ['https://alpha.org/one']),
      member('b', ['https://beta.net/two']),
    ]);
    expect(profile.pairs[0]!.urlJaccard).toBe(0);
    expect(profile.pairs[0]!.domainJaccard).toBe(0);
  });

  it('and still finds the shared conclusion', () => {
    const convergence = claimConvergence([
      claimSet('a', [claim], ['https://alpha.org/one']),
      claimSet('b', [claim], ['https://beta.net/two']),
    ]);
    expect(convergence.candidates.length).toBeGreaterThan(0);
    expect([...convergence.candidates[0]!.providers].sort()).toEqual(['a', 'b']);
  });

  it('so one is high exactly where the other is zero, in both directions', () => {
    const overlap = sourceOverlapProfile([
      member('a', ['https://alpha.org/one']),
      member('b', ['https://beta.net/two']),
    ]).pairs[0]!.urlJaccard;
    const converged = claimConvergence([
      claimSet('a', [claim], ['https://alpha.org/one']),
      claimSet('b', [claim], ['https://beta.net/two']),
    ]).candidates.length;
    expect(overlap).toBe(0);
    expect(converged).toBeGreaterThan(0);
  });
});

describe('what convergence is never allowed to mean', () => {
  it('carries the caution on every report', () => {
    const report = claimConvergence([claimSet('a', ['x']), claimSet('b', ['x'])]);
    expect(report.caution).toBe(CONVERGENCE_IS_NOT_CORROBORATION);
    expect(report.caution).toMatch(/never evidence a conclusion is right/i);
    expect(report.caution).toMatch(/agreement between backends\s+is not corroboration/i);
    // And it says explicitly that it is a different measurement from source
    // overlap, so the two cannot be quoted interchangeably from the output.
    expect(report.caution).toMatch(/different measurement from\s+source overlap/i);
  });

  it('reports the threshold so a reader can re-run it at another value', () => {
    expect(claimConvergence([claimSet('a', ['x'])]).threshold).toBe(0.2);
    expect(claimConvergence([claimSet('a', ['x'])], 0.5).threshold).toBe(0.5);
  });

  it('does not treat one backend saying something twice as convergence', () => {
    const twice = 'The regulator confirmed the merger review will extend into the fourth quarter of 2026';
    const report = claimConvergence([claimSet('solo', [twice, twice])]);
    expect(report.candidates).toEqual([]);
  });
});
