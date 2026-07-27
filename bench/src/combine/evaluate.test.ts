import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  combinationId,
  evaluateCombinations,
  evaluateScopes,
  type CombinationMember,
} from './index.js';
import { MAX_EXACT_MEMBERS } from './marginal.js';
import type { MeasureLabel } from './frontier.js';
import { eccentricTrio, failedRun, goldSourceScorer, member, run, subscriptionRun } from './fixtures.js';

const ACCURACY: MeasureLabel = { name: 'accuracy', direction: 'higher-is-better' };

const countSources = (m: { citedUrls: readonly string[] }): number => m.citedUrls.length;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evaluating the lattice costs nothing and reaches nothing (COMB-01)', () => {
  it('completes a full subset evaluation with fetch replaced by a throwing stub', () => {
    // The acceptance criterion, and it is an assertion rather than an
    // aspiration: a combination is a merge of stored cells, so if this touches
    // the network the design has been abandoned rather than implemented.
    const fetchSpy = vi.fn(() => {
      throw new Error('the combination evaluator attempted a network call');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { members } = eccentricTrio();
    const report = evaluateCombinations({
      members,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });

    expect(report.combinations).toHaveLength(7); // 2^3 - 1
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says so in the report rather than leaving it to be assumed', () => {
    const { members } = eccentricTrio();
    const report = evaluateCombinations({
      members,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    expect(report.notes.join(' ')).toMatch(/zero network calls\s+and zero spend/);
  });
});

describe('no module here can reach a network or a disk (COMB-02)', () => {
  it('imports nothing that fetches, spends or opens a file', () => {
    // Stronger than the runtime check above, and the reason both exist: "it
    // happened not to fetch this time" is a different claim from "it cannot
    // fetch". This one reads the source, so a future import is caught the day
    // it lands rather than the day a test happens to exercise it.
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'fixtures.ts',
    );
    expect(sources.length).toBeGreaterThan(5);

    const forbidden = [
      /from 'node:fs'/,
      /from 'node:https?'/,
      /from 'node:net'/,
      /from 'node:child_process'/,
      /safe-fetch/,
      /bench\/src\/citations/,
      /\.\.\/citations\//,
      /research\/citations\.js/,
      /\bfetch\s*\(/,
    ];
    for (const file of sources) {
      const src = readFileSync(`${dir}${file}`, 'utf8');
      const imports = [...src.matchAll(/^import[\s\S]*?from\s+'[^']+';/gm)].map((m) => m[0]).join('\n');
      for (const pattern of forbidden) {
        expect(`${file}: ${imports}`).not.toMatch(pattern);
        // And no bare call either, not only no import.
        if (pattern.source.includes('fetch\\s*\\(')) expect(`${file}: ${src}`).not.toMatch(pattern);
      }
    }
  });
});

describe('a combination of one is that member exactly (COMB-04)', () => {
  it('scores identically to the member evaluated alone', () => {
    // Through a scorer that hashes what it was handed, so this fails if the
    // merge changes a single character of the report or a single URL.
    const seen = new Map<string, string>();
    const hashing = (m: { markdown: string; citedUrls: readonly string[] }): number => {
      const key = `${m.markdown}::${m.citedUrls.join('|')}`;
      seen.set(key, key);
      return key.length;
    };

    const members = [member('a', ['https://x.com/1']), member('b', ['https://y.com/2'])];
    const full = evaluateCombinations({ members, scoreCombination: hashing, measure: ACCURACY });
    const alone = evaluateCombinations({
      members: [members[0]!],
      scoreCombination: hashing,
      measure: ACCURACY,
    });

    const inLattice = full.combinations.find((c) => c.id === 'a');
    expect(inLattice!.score).toBe(alone.combinations[0]!.score);
    expect(inLattice!.merged.markdown).toBe(alone.combinations[0]!.merged.markdown);
    expect(inLattice!.merged.citedUrls).toEqual(alone.combinations[0]!.merged.citedUrls);
  });
});

describe('the obscure member is not the most valuable one (COMB-12)', () => {
  const { members, centralUrls } = eccentricTrio();

  it('tops the source count, which is why a source count is the wrong value function', () => {
    const byCount = evaluateCombinations({
      members,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    if (!byCount.marginal?.exact) throw new Error('expected an exact credit split');
    const ranked = [...byCount.marginal.perMember].sort((a, b) => b.shapley - a.shapley);
    // Over a raw source count the eccentric member wins outright. This is the
    // trap stated as a test: it is the reason the credit split runs over the
    // SCORE and never over breadth.
    expect(ranked[0]!.memberId).toBe('obscure');
  });

  it('and comes last on the score, which is the number that decides', () => {
    const byScore = evaluateCombinations({
      members,
      scoreCombination: goldSourceScorer(centralUrls),
      measure: ACCURACY,
    });
    if (!byScore.marginal?.exact) throw new Error('expected an exact credit split');
    const ranked = [...byScore.marginal.perMember].sort((a, b) => b.shapley - a.shapley);
    expect(ranked.at(-1)!.memberId).toBe('obscure');
    expect(ranked.find((m) => m.memberId === 'obscure')!.shapley).toBeCloseTo(0, 9);
  });

  it('never reaches the frontier on its own once the score is what counts', () => {
    const byScore = evaluateCombinations({
      members,
      scoreCombination: goldSourceScorer(centralUrls),
      measure: ACCURACY,
    });
    expect(byScore.frontier.frontier.map((c) => c.id)).not.toContain('obscure');
    const dominated = byScore.frontier.dominated.find((d) => d.id === 'obscure');
    expect(dominated).toBeDefined();
  });

  it('says why in the notes, so the next reader does not reinvent the count', () => {
    const byScore = evaluateCombinations({
      members,
      scoreCombination: goldSourceScorer(centralUrls),
      measure: ACCURACY,
    });
    expect(byScore.notes.join(' ')).toMatch(/eccentricity rather than value/);
  });
});

describe('overlap stays a curve (COMB-14 through the evaluator)', () => {
  it('returns bins in ascending overlap and never an ordering on quality', () => {
    const { members, centralUrls } = eccentricTrio();
    const report = evaluateCombinations({
      members,
      scoreCombination: goldSourceScorer(centralUrls),
      measure: ACCURACY,
    });
    expect(report.overlapCurve.length).toBeGreaterThan(0);
    for (let i = 1; i < report.overlapCurve.length; i += 1) {
      expect(report.overlapCurve[i]!.lower).toBeGreaterThan(report.overlapCurve[i - 1]!.lower);
    }
    expect(report.frontier.axes).not.toHaveProperty('overlap');
  });

  it('carries the caution on every combination profile', () => {
    const { members } = eccentricTrio();
    const report = evaluateCombinations({
      members,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    for (const c of report.combinations) {
      expect(c.overlap.caution).toMatch(/not monotonically better/i);
    }
  });
});

describe('the ceiling is one limit with one wording (COMB-22, COMB-23)', () => {
  const tooMany: CombinationMember[] = Array.from({ length: MAX_EXACT_MEMBERS + 1 }, (_, i) =>
    member(`m${String(i)}`, [`https://x${String(i)}.com/1`]),
  );

  it('refuses to enumerate above the member ceiling', () => {
    expect(() =>
      evaluateCombinations({ members: tooMany, scoreCombination: countSources, measure: ACCURACY }),
    ).toThrow(/sampling is deliberately not offered/i);
  });

  it('still scores an explicit shortlist exactly, with no credit split', () => {
    const report = evaluateCombinations({
      members: tooMany,
      scoreCombination: countSources,
      measure: ACCURACY,
      combinations: [['m0'], ['m1'], ['m0', 'm1']],
    });
    expect(report.combinations).toHaveLength(3);
    expect(report.exhaustive).toBe(false);
    // Not approximated: absent. A Shapley value over a shortlist is not the
    // Shapley value of anything.
    expect(report.marginal).toBeUndefined();
    expect(report.notes.join(' ')).toMatch(/not the Shapley value of anything/);
  });

  it('caps the shortlist, so the ceiling cannot be walked around by hand', () => {
    const many = Array.from({ length: 5000 }, () => ['m0']);
    expect(() =>
      evaluateCombinations({
        members: tooMany,
        scoreCombination: countSources,
        measure: ACCURACY,
        combinations: many,
      }),
    ).toThrow(/exceeds the cap/i);
  });

  it('refuses a duplicated combination, which would double its weight in the curve', () => {
    const members = [member('a', ['https://x.com/1']), member('b', ['https://y.com/1'])];
    expect(() =>
      evaluateCombinations({
        members,
        scoreCombination: countSources,
        measure: ACCURACY,
        combinations: [['a', 'b'], ['b', 'a']],
      }),
    ).toThrow(/requested twice/i);
  });

  it('refuses an empty combination and an unknown member', () => {
    const members = [member('a', [])];
    expect(() =>
      evaluateCombinations({ members, scoreCombination: countSources, measure: ACCURACY, combinations: [[]] }),
    ).toThrow(/not a purchase/i);
    expect(() =>
      evaluateCombinations({
        members,
        scoreCombination: countSources,
        measure: ACCURACY,
        combinations: [['ghost']],
      }),
    ).toThrow(/not in the member set/i);
  });
});

describe('per category as well as overall (COMB-30, COMB-31)', () => {
  it('produces a frontier per scope and one over everything', () => {
    const timeBound = [
      member('fast', ['https://news.example.org/today']),
      member('deep', ['https://journal.example.org/paper']),
    ];
    const literature = [
      member('fast', ['https://news.example.org/other']),
      member('deep', ['https://journal.example.org/paper', 'https://journal.example.org/second']),
    ];

    const report = evaluateScopes(
      [
        { name: 'time-bound', members: timeBound },
        { name: 'primary-literature', members: literature },
      ],
      (merged, scope) =>
        scope === 'time-bound'
          ? merged.citedUrls.filter((u) => u.includes('news')).length
          : merged.citedUrls.filter((u) => u.includes('journal')).length,
      { name: 'category-fit', direction: 'higher-is-better' },
    );

    expect(report.byScope.map((s) => s.scope)).toEqual(['time-bound', 'primary-literature']);
    expect(report.overall.combinations.length).toBeGreaterThan(0);

    // The point of reporting per category: the winner differs, and one global
    // winner would hide exactly the routing decision this exists to inform.
    const bestIn = (scope: string): string => {
      const found = report.byScope.find((s) => s.scope === scope)!;
      return [...found.report.combinations].sort((a, b) => b.score - a.score || a.costUsd - b.costUsd)[0]!.id;
    };
    expect(bestIn('time-bound')).not.toBe(bestIn('primary-literature'));
  });

  it('keeps a member absent from one scope in the lattice, contributing nothing there', () => {
    const withBoth = [member('a', ['https://x.com/1']), member('b', ['https://y.com/1'])];
    const withoutB = [member('a', ['https://x.com/2'])];
    const report = evaluateScopes(
      [
        { name: 'full', members: withBoth },
        { name: 'partial', members: withoutB },
      ],
      (merged) => merged.citedUrls.length,
      { name: 'source-count', direction: 'higher-is-better' },
    );
    const partial = report.byScope.find((s) => s.scope === 'partial')!.report;
    // Both scopes evaluate the same lattice, so the frontiers are comparable.
    expect(partial.combinations).toHaveLength(3);
    const bOnly = partial.combinations.find((c) => c.id === 'b')!;
    expect(bOnly.merged.citedUrls).toEqual([]);
    expect(bOnly.score).toBe(0);
  });

  it('refuses a member whose independence differs between scopes', () => {
    expect(() =>
      evaluateScopes(
        [
          { name: 'one', members: [member('a', [])] },
          { name: 'two', members: [{ id: 'a', independence: 'saw-other-members', runs: [] }] },
        ],
        () => 0,
        ACCURACY,
      ),
    ).toThrow(/property of how the research was produced/i);
  });
});

describe('failures and unmetered spend reach the report (COMB-37, COMB-38)', () => {
  it('carries a completion rate that failed runs actually move', () => {
    const half: CombinationMember = {
      id: 'flaky',
      independence: 'independent',
      runs: [run('flaky', ['https://x.com/1']), failedRun('flaky')],
    };
    const report = evaluateCombinations({
      members: [half],
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    expect(report.combinations[0]!.merged.completionRate).toBe(0.5);
    expect(report.combinations[0]!.merged.runCount).toBe(2);
    expect(report.combinations[0]!.merged.completedRunCount).toBe(1);
    expect(report.notes.join(' ')).toMatch(/Completion rate is a validity metric/);
  });

  it('counts a subscription run without costing it', () => {
    const sub: CombinationMember = {
      id: 'cli',
      independence: 'independent',
      runs: [subscriptionRun('cli', ['https://x.com/1'])],
    };
    const report = evaluateCombinations({
      members: [sub],
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    expect(report.combinations[0]!.costUsd).toBe(0);
    expect(report.combinations[0]!.merged.cost.subscriptionRuns).toBe(1);
    expect(report.notes.join(' ')).toMatch(/counted and never costed/);
  });

  it('never lets a failed run contribute text or sources', () => {
    const failedOnly: CombinationMember = {
      id: 'dead',
      independence: 'independent',
      runs: [failedRun('dead')],
    };
    const report = evaluateCombinations({
      members: [failedOnly],
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    expect(report.combinations[0]!.merged.citedUrls).toEqual([]);
    expect(report.combinations[0]!.merged.markdown).toBe('');
    expect(report.combinations[0]!.merged.completionRate).toBe(0);
  });
});

describe('the report is honest about being point estimates (COMB-35)', () => {
  it('says a frontier from point estimates must not authorise a routing change alone', () => {
    const { members } = eccentricTrio();
    const report = evaluateCombinations({
      members,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    expect(report.notes.join(' ')).toMatch(/must not authorise a\s+routing change on its own/);
  });
});

describe('combinationId', () => {
  it('is order independent, so a+b and b+a are one combination', () => {
    expect(combinationId(['b', 'a'])).toBe(combinationId(['a', 'b']));
  });
});
