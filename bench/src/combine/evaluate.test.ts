import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findImpureImports } from '../import-graph.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  combinationId,
  evaluateCombinations,
  evaluateScopes,
  type CombinationEligibility,
  type CombinationMember,
  type EvaluateInput,
  scoreSpread,
  type ScopedCombinationReport,
} from './index.js';
import { MAX_EXACT_MEMBERS } from './marginal.js';
import type { MergedCombination } from './merge.js';
import type { MeasureLabel } from './frontier.js';
import {
  admitted,
  eccentricTrio,
  failedRun,
  goldSourceScorer,
  member,
  run,
  subscriptionRun,
} from './fixtures.js';

const ACCURACY: MeasureLabel = { name: 'accuracy', direction: 'higher-is-better' };

const countSources = (m: { citedUrls: readonly string[] }): number => m.citedUrls.length;

/**
 * `evaluateCombinations` with an aggregate that admits everything.
 *
 * `eligibility` became required in BENCH-17, and threading a permissive
 * fixture through the pre-existing cases rather than rewriting them is what
 * makes a diff in any assertion below a real behaviour change instead of an
 * artefact of the new field. The floors are exercised where they bite, in
 * `frontier.test.ts` and `eligibility.test.ts` and in the withheld cases at the
 * bottom of this file.
 */
const evaluate = (
  input: Omit<EvaluateInput, 'eligibility'> & { readonly eligibility?: CombinationEligibility },
): ReturnType<typeof evaluateCombinations> =>
  evaluateCombinations({ ...input, eligibility: input.eligibility ?? admitted(input.members) });

/** The same for the scoped form, over the union of member ids across scopes. */
const evaluateAllScopes = (
  scopes: readonly { readonly name: string; readonly members: readonly CombinationMember[] }[],
  scoreCombination: (merged: MergedCombination, scope: string) => number,
  measure: MeasureLabel,
): ScopedCombinationReport => {
  const everyMember = scopes.flatMap((s) => [...s.members]);
  return evaluateScopes(
    scopes.map((s) => ({ ...s, eligibility: admitted(everyMember) })),
    scoreCombination,
    measure,
    { overallEligibility: admitted(everyMember) },
  );
};

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
    const report = evaluate({
      members,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });

    expect(report.combinations).toHaveLength(7); // 2^3 - 1
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says so in the report rather than leaving it to be assumed', () => {
    const { members } = eccentricTrio();
    const report = evaluate({
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

  it('and the one file whose dependency moved outside this directory is walked, not read', () => {
    // BENCH-15 opened a hop the check above cannot see: `identity.ts` now
    // re-exports the scheme fold from `../score/source-identity.ts`, so the
    // import this guard used to read off `identity.ts` is no longer in the
    // directory it scans. The transitive walk closes it, and `identity.ts` is
    // clean through every hop.
    //
    // **Only that file, and the reason is measured rather than a preference.**
    // `bench/src/import-graph.ts` follows an `import type` edge, which is
    // erased under `verbatimModuleSyntax` and is not a runtime edge at all.
    // `eligibility.ts` takes three types from `bench/src/report/aggregate.ts`,
    // and following that erased edge reports seven files here as reaching
    // `node:fs`, `node:fs/promises` and `node:child_process` eight hops away
    // through `src/local/cli.ts`. Teaching the walk to skip a type-only
    // statement would reverse a decision BENCH-19 took deliberately and pinned
    // with its own test, and would change what its exact-reach assertion for
    // `detector/report.ts` says. That needs an owner rather than a drive-by.
    const reaches = findImpureImports(fileURLToPath(new URL('./identity.ts', import.meta.url)));
    expect(reaches.map((r) => `${r.module} via ${r.path.join(' -> ')}`)).toEqual([]);
  });

  it('would notice if that file stopped being clean', () => {
    // A purity assertion that is green because it can no longer see anything is
    // the failure this whole section is about.
    const reaches = findImpureImports(
      fileURLToPath(new URL('../citations/collect.ts', import.meta.url)),
    );
    expect(reaches.length).toBeGreaterThan(0);
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
    const full = evaluate({ members, scoreCombination: hashing, measure: ACCURACY });
    const alone = evaluate({
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
    const byCount = evaluate({
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
    const byScore = evaluate({
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
    const byScore = evaluate({
      members,
      scoreCombination: goldSourceScorer(centralUrls),
      measure: ACCURACY,
    });
    expect(byScore.scorable).toBe(true);
    expect(byScore.frontier.frontier?.map((c) => c.id)).not.toContain('obscure');
    const dominated = byScore.frontier.dominated.find((d) => d.id === 'obscure');
    expect(dominated).toBeDefined();
  });

  it('says why in the notes, so the next reader does not reinvent the count', () => {
    const byScore = evaluate({
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
    const report = evaluate({
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
    const report = evaluate({
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
      evaluate({ members: tooMany, scoreCombination: countSources, measure: ACCURACY }),
    ).toThrow(/sampling is deliberately not offered/i);
  });

  it('still scores an explicit shortlist exactly, with no credit split', () => {
    const report = evaluate({
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
      evaluate({
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
      evaluate({
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
      evaluate({ members, scoreCombination: countSources, measure: ACCURACY, combinations: [[]] }),
    ).toThrow(/not a purchase/i);
    expect(() =>
      evaluate({
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

    const report = evaluateAllScopes(
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
    const report = evaluateAllScopes(
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
      evaluateAllScopes(
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
    const report = evaluate({
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
    const report = evaluate({
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
    const report = evaluate({
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
    const report = evaluate({
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

describe('the numbers survive a withheld frontier (COMB-42)', () => {
  const { members, centralUrls } = eccentricTrio();
  const underSampled: CombinationEligibility = {
    ...admitted(members),
    scope: {
      scorable: false,
      reason: 'under-sampled-corpus',
      why:
        'the corpus holds 1 technical task, below the floor of 5. No backend is scored in this ' +
        'category; the fix is authoring tasks, not re-running.',
    },
  };

  it('withholds the frontier and still reports every score, cost and overlap profile', () => {
    const report = evaluate({
      members,
      scoreCombination: goldSourceScorer(centralUrls),
      measure: ACCURACY,
      eligibility: underSampled,
    });
    expect(report.scorable).toBe(false);
    expect(report.frontier.frontier).toBeNull();
    expect(report.frontier.dominated).toEqual([]);
    expect(report.frontier.withheld?.reason).toBe('scope-not-scorable');
    // The numbers are the numbers. Only the ordering is withheld.
    expect(report.combinations).toHaveLength(7);
    for (const c of report.combinations) {
      expect(Number.isFinite(c.score)).toBe(true);
      expect(Number.isFinite(c.costUsd)).toBe(true);
      expect(c.overlap.robustness).toBeDefined();
    }
  });

  it('carries the scope verdict on the report, and says in the notes why nothing is stated', () => {
    const report = evaluate({
      members,
      scoreCombination: goldSourceScorer(centralUrls),
      measure: ACCURACY,
      eligibility: underSampled,
    });
    expect(report.scope).toEqual(underSampled.scope);
    expect(report.notes.join(' ')).toContain('below the floor of 5');
    expect(report.notes.join(' ')).toMatch(/inherits the same limit/);
  });
});

describe('a combination is only as eligible as its worst member (COMB-44, COMB-45)', () => {
  const members = [member('a', ['https://x.com/1']), member('b', ['https://y.com/1'])];

  it('blocks every combination holding a member the aggregate withheld (COMB-45)', () => {
    const eligibility: CombinationEligibility = {
      scope: { scorable: true },
      members: {
        ...admitted(members).members,
        b: {
          verdict: {
            scorable: false,
            reason: 'nothing-completed',
            why: 'openai completed no technical task, so there is nothing to score.',
          },
          repetitionFloor: { met: true, minRepetitions: 5, floor: 3, why: '' },
        },
      },
    };
    const report = evaluate({
      members,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
      eligibility,
    });
    // `a` is fine; `b` and `a+b` both hold a member that may not be scored, so
    // one candidate remains and one candidate is not a frontier.
    expect(report.frontier.excluded.map((e) => e.id).sort()).toEqual(['a+b', 'b']);
    expect(report.frontier.withheld?.reason).toBe('too-few-candidates');
    expect(report.frontier.withheld?.why).toContain('nothing to score');
  });

  it('treats a member the caller did not describe as not scorable, and names it (COMB-44)', () => {
    const eligibility: CombinationEligibility = {
      scope: { scorable: true },
      members: { a: admitted(members).members['a']! },
    };
    const report = evaluate({
      members,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
      eligibility,
    });
    expect(report.scorable).toBe(false);
    expect(report.frontier.excluded.map((e) => e.id).sort()).toEqual(['a+b', 'b']);
    expect(report.frontier.excluded.map((e) => e.why).join(' ')).toMatch(
      /member "b" has no eligibility/,
    );
  });

  it('carries a thin member up into every combination holding it', () => {
    const eligibility: CombinationEligibility = {
      scope: { scorable: true },
      members: {
        ...admitted(members).members,
        b: {
          verdict: { scorable: true },
          repetitionFloor: {
            met: false,
            minRepetitions: 1,
            floor: 3,
            why: 'at least one task completed only 1 repetition, below the floor of 3.',
          },
        },
      },
    };
    const report = evaluate({
      members,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
      eligibility,
    });
    expect(report.frontier.withheld?.reason).toBe('sample-below-spread-floor');
    expect(report.frontier.excluded.map((e) => e.id).sort()).toEqual(['a+b', 'b']);
  });
});

describe('the completion floor arrives inside the verdict, never as a rule of our own (COMB-50)', () => {
  it('no file in this directory names a completion threshold', () => {
    // The brief noted that `evaluate.ts` computed `worstCompletion` and spent it
    // on a prose note. The fix is NOT to threshold that number:
    // MIN_COMPLETION_SHARE is already the fourth arm of `verdictFor`, so gating
    // on the verdict applies it once. A second threshold here would be a fifth
    // floor, disagreeing with the four in `aggregate.ts` the moment either moved.
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of sources) {
      // Comments stripped first, deliberately. `eligibility.ts` names the
      // constant in prose to say where the floor lives, which is the opposite
      // of using it, and a check that could not tell those apart would push the
      // explanation out of the file.
      const code = readFileSync(`${dir}${file}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(`${file}: ${code}`).not.toMatch(/MIN_COMPLETION_SHARE/);
      expect(`${file}: ${code}`).not.toMatch(/minCompletionShare/);
      // Every comparison against any completion-shaped value, aliased or not,
      // enumerated rather than pattern-banned. The earlier version of this
      // check greped for `completionRate` followed by an operator, and
      // `evaluate.ts` aliases the value one statement before comparing it, so a
      // future `if (worstCompletion < 0.6) return withheld` would have walked
      // straight past a test whose whole job is to stop exactly that.
      const comparisons = [
        ...code.matchAll(/\b(\w*[cC]ompletion\w*)\s*(<=|>=|<|>)\s*([\w.]+)/g),
      ].map((m) => `${m[1] ?? ''} ${m[2] ?? ''} ${m[3] ?? ''}`);
      for (const found of comparisons) {
        // The one permitted comparison decides whether to PRINT a note, not
        // whether a figure may be quoted. Anything else is a fifth floor.
        expect(`${file}: ${found}`).toContain('worstCompletion < 1');
      }
    }
  });

  it('withholds on a low completion rate only because the verdict said so', () => {
    const half: CombinationMember = {
      id: 'flaky',
      independence: 'independent',
      runs: [run('flaky', ['https://x.com/1']), failedRun('flaky'), failedRun('flaky')],
    };
    const sound = member('steady', ['https://y.com/1']);
    const list = [half, sound];

    // Same runs, same 33% completion, two different verdicts. The frontier
    // follows the verdict rather than the rate, which is the whole point.
    const admittedReport = evaluate({
      members: list,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    expect(admittedReport.scorable).toBe(true);
    expect(admittedReport.combinations.find((c) => c.id === 'flaky')!.merged.completionRate).toBeCloseTo(
      1 / 3,
      9,
    );

    const withheldReport = evaluate({
      members: list,
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
      eligibility: {
        scope: { scorable: true },
        members: {
          ...admitted(list).members,
          flaky: {
            verdict: {
              scorable: false,
              reason: 'under-completed',
              why:
                'flaky completed 33.3% of its attempted technical cells, below the floor of 60.0%. ' +
                'The score is rendered invalid rather than as a number.',
            },
            repetitionFloor: { met: true, minRepetitions: 5, floor: 3, why: '' },
          },
        },
      },
    });
    expect(withheldReport.scorable).toBe(false);
    expect(withheldReport.frontier.excluded.map((e) => e.why).join(' ')).toMatch(/below the floor of 60\.0%/);
  });
});

describe('the adapter is inside the purity boundary (COMB-52)', () => {
  it('scans eligibility.ts along with the rest of the directory', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    // Named explicitly, because the adapter is the one file here that has seen a
    // BenchAggregate and is therefore the likeliest place a filesystem import
    // would arrive, through `report/cli.ts` on the way to loading one.
    expect(sources).toContain('eligibility.ts');
    const src = readFileSync(`${dir}eligibility.ts`, 'utf8');
    expect(src).not.toMatch(/from 'node:/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/report\/cli\.js/);
  });
});

describe('the tie test reaches the production path (COMB-53)', () => {
  const members = [member('alpha', ['https://x.example.org/1']), member('beta', ['https://y.example.org/1'])];
  // Two combinations 0.001 apart, which is the brief's headline number, and
  // spreads that overlap heavily. Without a way to supply the spread there was
  // no tie test on this path at all and `beta` dominated `alpha` outright.
  const scores: Record<string, number> = { alpha: 0.8, beta: 0.801, 'alpha+beta': 0.802 };
  const samples: Record<string, readonly number[]> = {
    alpha: [0.7, 0.8, 0.9],
    beta: [0.71, 0.801, 0.91],
    'alpha+beta': [0.72, 0.802, 0.92],
  };
  const scoreCombination = (m: MergedCombination): number => scores[combinationId(m.memberIds)] ?? 0;

  it('ties two combinations whose supplied spreads overlap, so neither dominates', () => {
    const report = evaluate({
      members,
      scoreCombination,
      scoreSpread: (m) => scoreSpread(samples[combinationId(m.memberIds)] ?? []),
      measure: ACCURACY,
    });
    expect(report.frontier.withheld).toBeNull();
    expect(report.frontier.separation).toBe('checked');
    expect(report.frontier.dominated).toEqual([]);
    expect(report.frontier.frontier?.map((c) => c.id).sort()).toEqual(['alpha', 'alpha+beta', 'beta']);
  });

  it('dominates on the same numbers when no spread is supplied, which is what used to always happen', () => {
    const report = evaluate({ members, scoreCombination, measure: ACCURACY });
    expect(report.frontier.separation).toBe('point');
    expect(report.frontier.dominated.map((d) => d.id)).toContain('alpha');
  });

  it('carries the spread onto every evaluation, so a reader can see what was compared', () => {
    const report = evaluate({
      members,
      scoreCombination,
      scoreSpread: (m) => scoreSpread(samples[combinationId(m.memberIds)] ?? []),
      measure: ACCURACY,
    });
    for (const c of report.combinations) {
      expect(c.scoreSpread?.n).toBe(3);
      expect(c.scoreSpread?.spread).not.toBeNull();
    }
  });

  it('reports a partial supply as mixed rather than as checked', () => {
    const report = evaluate({
      members,
      scoreCombination,
      // Only `alpha` gets one, so the pair between `beta` and `alpha+beta` has
      // neither side measured. That is the one genuinely mixed shape: a pair
      // where either side carries a spread still reaches the spread rule.
      scoreSpread: (m) =>
        combinationId(m.memberIds) === 'alpha' ? scoreSpread(samples['alpha'] ?? []) : null,
      measure: ACCURACY,
    });
    expect(report.frontier.separation).toBe('mixed');
  });

  it('threads the same callback through evaluateScopes, per scope', () => {
    const scoped = evaluateScopes(
      [{ name: 'technical', members, eligibility: admitted(members) }],
      scoreCombination,
      ACCURACY,
      {
        overallEligibility: admitted(members),
        scoreSpread: (m) => scoreSpread(samples[combinationId(m.memberIds)] ?? []),
      },
    );
    expect(scoped.byScope[0]!.report.frontier.separation).toBe('checked');
    expect(scoped.overall.frontier.separation).toBe('checked');
  });
});

describe('a member that never ran is not a member that failed everything (DUP-10)', () => {
  const empty: CombinationMember = { id: 'never-ran', independence: 'independent', runs: [] };

  it('merges to a null completion rate rather than to zero', () => {
    const report = evaluate({
      members: [empty, member('steady', ['https://y.com/1'])],
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    const own = report.combinations.find((c) => c.id === 'never-ran');
    expect(own?.merged.completionRate).toBeNull();
    expect(own?.merged.runCount).toBe(0);
  });

  it('does not print itself as the least reliable purchase on the board', () => {
    // The note is about how much of what was ATTEMPTED finished. A combination
    // that attempted nothing has no answer to that, and folding its null in as
    // a zero would have made it the worst figure in every report it appeared
    // in, for the one state that is not a result at all.
    const report = evaluate({
      members: [empty, member('steady', ['https://y.com/1'])],
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    expect(report.notes.join(' ')).not.toMatch(/least reliable combination/);
  });

  it('still prints the note when a combination really did fail some attempts', () => {
    const flaky: CombinationMember = {
      id: 'flaky',
      independence: 'independent',
      runs: [run('flaky', ['https://x.com/1']), failedRun('flaky')],
    };
    const report = evaluate({
      members: [empty, flaky],
      scoreCombination: countSources,
      measure: { name: 'source-count', direction: 'higher-is-better' },
    });
    expect(report.notes.join(' ')).toMatch(/least reliable combination completed 50%/);
  });
});
