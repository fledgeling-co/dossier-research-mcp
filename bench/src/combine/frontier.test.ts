import { describe, expect, it } from 'vitest';
import type { ScorableVerdict } from '../report/aggregate.js';
import type { SeparationOracle } from '../report/rank.js';
import {
  paretoFrontier,
  SEPARABILITY_CHECKED,
  SEPARABILITY_MIXED,
  SEPARABILITY_NOT_STATED,
  SEPARABILITY_UNCHECKED,
  type CandidateEligibility,
  type FrontierCandidate,
  type FrontierOptions,
  type MeasureLabel,
} from './frontier.js';
import { scoreSpread as spreadOf } from './spread-helpers.js';

const ACCURACY: MeasureLabel = { name: 'accuracy', direction: 'higher-is-better' };
const BRIER: MeasureLabel = { name: 'brier', direction: 'lower-is-better' };

/**
 * A candidate BENCH-08 would admit.
 *
 * Every pre-existing case in this file is threaded through this rather than
 * rewritten, so a diff in one of their assertions is a real behaviour change
 * and not an artefact of the new required field.
 */
const ADMITTED: CandidateEligibility = {
  scorable: true,
  why: '',
  repetitionsMet: true,
  repetitionsWhy: '',
};

const SCORABLE: FrontierOptions = { scope: { scorable: true } };

const at = (id: string, score: number, costUsd: number, robustness: number): FrontierCandidate => ({
  id,
  score,
  costUsd,
  robustness,
  eligibility: ADMITTED,
});

describe('a dominated combination never reaches the frontier (COMB-24)', () => {
  it('drops one that is worse on every axis at once', () => {
    const good = at('good', 0.9, 1, 0.8);
    const bad = at('bad', 0.5, 5, 0.2);
    const result = paretoFrontier([good, bad], ACCURACY, SCORABLE);
    expect(result.frontier?.map((c) => c.id)).toEqual(['good']);
    expect(result.dominated).toHaveLength(1);
    expect(result.dominated[0]!.id).toBe('bad');
    expect(result.dominated[0]!.dominatedBy).toBe('good');
  });

  it('drops one that ties on score and robustness but costs more', () => {
    // The case the brief calls out: row nine costing six times row three for
    // nothing. It is dominated even though it scores identically.
    const result = paretoFrontier(
      [at('cheap', 0.8, 1, 0.5), at('dear', 0.8, 6, 0.5)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.frontier?.map((c) => c.id)).toEqual(['cheap']);
    expect(result.dominated[0]!.why).toMatch(/costs \$1\.00 against \$6\.00/);
  });

  it('names the winner and the axes it won on, because "dominated" alone is not actionable', () => {
    const result = paretoFrontier(
      [at('winner', 0.9, 1, 0.9), at('loser', 0.4, 4, 0.1)],
      ACCURACY,
      SCORABLE,
    );
    const why = result.dominated[0]!.why;
    expect(why).toContain('"winner"');
    expect(why).toContain('accuracy');
    expect(why).toMatch(/no worse on any axis/);
  });

  it('names the first dominator in input order when several qualify', () => {
    // The pair sweep replaced a per-candidate `find`, so this pins the property
    // that change had to preserve: `i` ascends outermost, so the potential
    // dominators of a candidate are still visited in input order.
    const result = paretoFrontier(
      [at('first', 0.9, 1, 0.9), at('second', 0.9, 1, 0.9), at('loser', 0.1, 4, 0.1)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.dominated.map((d) => d.id)).toEqual(['loser']);
    expect(result.dominated[0]!.dominatedBy).toBe('first');
  });
});

describe('domination does not fire on a single-axis win (COMB-25)', () => {
  it('keeps a candidate that scores worse but costs less', () => {
    const result = paretoFrontier(
      [at('strong', 0.9, 5, 0.5), at('cheap', 0.6, 1, 0.5)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.frontier?.map((c) => c.id).sort()).toEqual(['cheap', 'strong']);
    expect(result.dominated).toEqual([]);
  });

  it('keeps a candidate that costs more but is more robust', () => {
    const result = paretoFrontier(
      [at('fragile', 0.8, 1, 0.1), at('sturdy', 0.8, 2, 0.9)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.dominated).toEqual([]);
  });

  it('keeps a candidate that is less robust but scores higher', () => {
    const result = paretoFrontier(
      [at('sharp', 0.95, 1, 0.2), at('steady', 0.7, 1, 0.95)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.dominated).toEqual([]);
  });
});

describe('ties on all three keep both (COMB-26)', () => {
  it('does not pick a winner by input order', () => {
    const result = paretoFrontier(
      [at('a', 0.8, 2, 0.5), at('b', 0.8, 2, 0.5)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.frontier?.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(result.dominated).toEqual([]);
  });
});

describe('the third axis earns its place (COMB-27)', () => {
  it('keeps a dearer combination that is better on score and robustness', () => {
    // Two axes would call this a straight trade and could not say which is
    // better. Three axes say it: `sturdy` wins on two and loses on one, so both
    // stay, and the reader sees the trade instead of a fabricated ordering.
    const result = paretoFrontier(
      [at('cheap', 0.7, 1, 0.3), at('sturdy', 0.85, 3, 0.9)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.dominated).toEqual([]);
  });

  it('lets robustness alone decide domination when score and cost tie', () => {
    // This is the case the brief says a two-axis frontier cannot express: same
    // score, same price, one survives losing a member better.
    const result = paretoFrontier(
      [at('brittle', 0.8, 2, 0.1), at('resilient', 0.8, 2, 0.9)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.frontier?.map((c) => c.id)).toEqual(['resilient']);
    expect(result.dominated[0]!.why).toMatch(/survives losing a member with 90\.0%/);
  });
});

describe('the axis shape is closed (COMB-28)', () => {
  it('carries exactly three comparison axes, and none of them is overlap', () => {
    const result = paretoFrontier([at('a', 1, 1, 1), at('b', 1, 1, 1)], ACCURACY, SCORABLE);
    expect(Object.keys(result.axes).sort()).toEqual(['costUsd', 'robustness', 'score']);
    // Overlap has no field here, which is the enforcement rather than the
    // convention: an axis IS a direction, and the brief says overlap must not
    // be given one.
    expect(Object.keys(result.axes)).not.toContain('overlap');
    const candidateKeys = Object.keys(result.frontier![0]!);
    expect(candidateKeys).not.toContain('overlap');
    expect(candidateKeys).not.toContain('meanUrlJaccard');
  });

  it('adds no numeric field an overlap measure could occupy', () => {
    // `scoreSpread` and `eligibility` arrived with BENCH-17 and neither is an
    // axis: nothing compares them for magnitude, and both only say whether a
    // comparison may be made at all. The three numbers are still the three.
    const withEverything: FrontierCandidate = {
      ...at('a', 0.8, 1, 0.5),
      scoreSpread: spreadOf([0.7, 0.8, 0.9]),
    };
    const numeric = Object.entries(withEverything)
      .filter(([, v]) => typeof v === 'number')
      .map(([k]) => k)
      .sort();
    expect(numeric).toEqual(['costUsd', 'robustness', 'score']);
  });

  it('states the direction of every axis rather than leaving it to be guessed', () => {
    const result = paretoFrontier([at('a', 1, 1, 1), at('b', 1, 1, 1)], ACCURACY, SCORABLE);
    expect(result.axes).toEqual({
      score: 'maximise',
      costUsd: 'minimise',
      robustness: 'maximise',
    });
  });
});

describe('the score axis is named and directed (COMB-33)', () => {
  it('refuses an unnamed measure', () => {
    expect(() =>
      paretoFrontier([at('a', 1, 1, 1)], { name: '  ', direction: 'higher-is-better' }, SCORABLE),
    ).toThrow(/named measure/i);
  });

  it('carries the measure onto the result', () => {
    expect(paretoFrontier([at('a', 1, 1, 1)], ACCURACY, SCORABLE).measure).toEqual(ACCURACY);
  });

  it('inverts a lower-is-better measure once, so the best Brier score wins', () => {
    // Unflipped, this would rank the worst-calibrated combination first and
    // nothing downstream could tell.
    const result = paretoFrontier(
      [at('well-calibrated', 0.05, 1, 0.5), at('badly-calibrated', 0.4, 1, 0.5)],
      BRIER,
      SCORABLE,
    );
    expect(result.frontier?.map((c) => c.id)).toEqual(['well-calibrated']);
    expect(result.dominated[0]!.id).toBe('badly-calibrated');
  });

  it('reports the score back in the caller units, never negated', () => {
    const result = paretoFrontier(
      [at('good', 0.05, 1, 0.5), at('bad', 0.4, 1, 0.5)],
      BRIER,
      SCORABLE,
    );
    expect(result.frontier![0]!.score).toBe(0.05);
    expect(result.dominated[0]!.why).toContain('0.0500');
    expect(result.dominated[0]!.why).not.toContain('-0.05');
  });
});

describe('a NaN is refused rather than silently undominated (COMB-29)', () => {
  it('throws on any non-finite axis', () => {
    for (const bad of [
      at('nan-score', Number.NaN, 1, 1),
      at('nan-cost', 1, Number.NaN, 1),
      at('nan-robust', 1, 1, Number.NaN),
      at('inf', Number.POSITIVE_INFINITY, 1, 1),
    ]) {
      expect(() => paretoFrontier([bad], ACCURACY, SCORABLE)).toThrow(/finite number/i);
    }
  });

  it('says why, because a NaN compares false against everything', () => {
    expect(() => paretoFrontier([at('x', Number.NaN, 1, 1)], ACCURACY, SCORABLE)).toThrow(
      /reported as undominated no matter how bad/i,
    );
  });

  it('refuses two candidates sharing an id', () => {
    expect(() =>
      paretoFrontier([at('same', 1, 1, 1), at('same', 0, 2, 0)], ACCURACY, SCORABLE),
    ).toThrow(/share the id/i);
  });

  it('checks the input before it checks the sample, so a NaN under a withheld scope still throws', () => {
    expect(() =>
      paretoFrontier([at('x', Number.NaN, 1, 1)], ACCURACY, {
        scope: { scorable: false, reason: 'under-sampled-corpus', why: 'too few tasks' },
      }),
    ).toThrow(/finite number/i);
  });
});

describe('what the sample can support (COMB-34)', () => {
  const withSpread = (
    id: string,
    score: number,
    costUsd: number,
    robustness: number,
    values: readonly number[],
  ): FrontierCandidate => ({ ...at(id, score, costUsd, robustness), scoreSpread: spreadOf(values) });

  it('treats overlapping score spreads as a tie, so neither dominates', () => {
    // 0.80 against 0.82 with spreads that overlap heavily. A point-estimate
    // frontier would call the second dominant and say nobody should buy the
    // first, which is a claim this sample cannot carry.
    const result = paretoFrontier(
      [
        withSpread('a', 0.8, 1, 0.5, [0.7, 0.8, 0.9]),
        withSpread('b', 0.82, 1, 0.5, [0.72, 0.82, 0.92]),
      ],
      ACCURACY,
      SCORABLE,
    );
    expect(result.frontier?.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(result.dominated).toEqual([]);
  });

  it('still separates them when the spreads do not overlap', () => {
    const result = paretoFrontier(
      [
        withSpread('weak', 0.2, 1, 0.5, [0.18, 0.2, 0.22]),
        withSpread('strong', 0.9, 1, 0.5, [0.88, 0.9, 0.92]),
      ],
      ACCURACY,
      SCORABLE,
    );
    expect(result.frontier?.map((c) => c.id)).toEqual(['strong']);
    expect(result.dominated[0]!.id).toBe('weak');
  });

  it('does not let an unestablished score difference rescue a candidate either', () => {
    // Tied on score by overlap, but strictly dearer: still dominated, on cost.
    const result = paretoFrontier(
      [
        withSpread('cheap', 0.8, 1, 0.5, [0.7, 0.8, 0.9]),
        withSpread('dear', 0.82, 9, 0.5, [0.72, 0.82, 0.92]),
      ],
      ACCURACY,
      SCORABLE,
    );
    expect(result.frontier?.map((c) => c.id)).toEqual(['cheap']);
    expect(result.dominated[0]!.why).toMatch(/cannot be separated on accuracy/);
  });

  it('ties a pair whose spreads were withheld below the floor, because unknown uncertainty cannot separate', () => {
    // `summarise` returns a report with a null spread below three results, and
    // `spreadsOverlap` treats a missing spread as overlapping. Supplying one is
    // therefore not a way to sneak a point-estimate comparison past the check.
    const result = paretoFrontier(
      [
        withSpread('a', 0.1, 1, 0.5, [0.1]),
        withSpread('b', 0.9, 1, 0.5, [0.9]),
      ],
      ACCURACY,
      SCORABLE,
    );
    expect(result.dominated).toEqual([]);
    expect(result.separation).toBe('checked');
  });
});

describe('the separability claim follows what actually happened (COMB-35, COMB-46, COMB-47)', () => {
  const spread = (id: string, score: number, values: readonly number[]): FrontierCandidate => ({
    ...at(id, score, 1, 0.5),
    scoreSpread: spreadOf(values),
  });

  it('says checked only when every eligible candidate carried a spread (COMB-47)', () => {
    const result = paretoFrontier(
      [spread('a', 0.8, [0.7, 0.8, 0.9]), spread('b', 0.82, [0.72, 0.82, 0.92])],
      ACCURACY,
      SCORABLE,
    );
    expect(result.separability).toBe(SEPARABILITY_CHECKED);
    expect(result.separation).toBe('checked');
    expect(result.pairs).toEqual({ total: 1, paired: 0, spread: 1, point: 0 });
  });

  it('says unchecked when none did', () => {
    const result = paretoFrontier([at('a', 0.8, 1, 0.5), at('b', 0.9, 1, 0.5)], ACCURACY, SCORABLE);
    expect(result.separability).toBe(SEPARABILITY_UNCHECKED);
    expect(result.separation).toBe('point');
    expect(result.pairs).toEqual({ total: 1, paired: 0, spread: 0, point: 1 });
  });

  it('says mixed rather than checked when a pair had neither side measured (COMB-46)', () => {
    // The trap, reproduced against the old code and fixed here. `paretoFrontier`
    // set the checked sentence when SOME candidate had a spread, while the
    // comparison needs BOTH, so pairs with one spread fell through to a raw
    // point comparison under a sentence claiming the sample had been asked.
    // Three candidates, one spread: two pairs reach the spread rule and the
    // pair between the two bare candidates does not, which is a genuinely
    // mixed result and now says so.
    const result = paretoFrontier(
      [spread('alpha', 0.8, [0.79, 0.8, 0.81]), at('beta', 0.801, 1, 0.5), at('gamma', 0.7, 1, 0.5)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.separability).toBe(SEPARABILITY_MIXED);
    expect(result.separation).toBe('mixed');
    expect(result.separability).not.toBe(SEPARABILITY_CHECKED);
    expect(result.pairs).toEqual({ total: 3, paired: 0, spread: 2, point: 1 });
    // And the sentence is true of this result rather than of a different one.
    expect(SEPARABILITY_MIXED).toMatch(/Some pairs were checked and some were not/);
  });

  it('does not let a bare point estimate eliminate the candidate that was measured (COMB-46)', () => {
    // The trap's second half, and it is a behaviour rather than a sentence.
    // `alpha` carries a spread of 0.79 to 0.81 and `beta` is a bare 0.801, so
    // `spreadsOverlap` has only one side to work with. It used to fall through
    // to a raw comparison and 0.001 eliminated the candidate that had actually
    // been measured, which made supplying evidence a liability. The pair is now
    // tied, on `spreadsOverlap`'s own rule that two values whose uncertainty is
    // unknown cannot be separated.
    const result = paretoFrontier(
      [spread('alpha', 0.8, [0.79, 0.8, 0.81]), at('beta', 0.801, 1, 0.5)],
      ACCURACY,
      SCORABLE,
    );
    expect(result.dominated).toEqual([]);
    expect(result.frontier?.map((c) => c.id).sort()).toEqual(['alpha', 'beta']);
    // One pair, decided by the spread rule, so every pair here was checked.
    expect(result.pairs).toEqual({ total: 1, paired: 0, spread: 1, point: 0 });
    expect(result.separation).toBe('checked');
  });

  it('still lets a one-sided pair be separated on cost or robustness', () => {
    // Tied on score is not immune. `cheap` cannot out-score `dear` on evidence
    // this thin, and it does not have to: it is strictly cheaper.
    const result = paretoFrontier(
      [
        { ...spread('cheap', 0.8, [0.79, 0.8, 0.81]), costUsd: 1 },
        { ...at('dear', 0.801, 9, 0.5) },
      ],
      ACCURACY,
      SCORABLE,
    );
    expect(result.dominated.map((d) => d.id)).toEqual(['dear']);
    expect(result.dominated[0]!.why).toMatch(/cannot be separated on accuracy/);
  });

  it('keeps the two sentences honest about what each is', () => {
    expect(SEPARABILITY_UNCHECKED).toMatch(/point-estimate/i);
    expect(SEPARABILITY_CHECKED).toMatch(/not a significance test/i);
    expect(SEPARABILITY_NOT_STATED).toMatch(/nothing was called dominated/i);
  });
});

describe('the scope has to be scorable before anything is (COMB-40)', () => {
  const UNDER_SAMPLED: ScorableVerdict = {
    scorable: false,
    reason: 'under-sampled-corpus',
    why:
      'the corpus holds 1 technical task, below the floor of 5. No backend is scored in this category; ' +
      'the fix is authoring tasks, not re-running.',
  };

  it('withholds the frontier and carries the aggregate own sentence, not a paraphrase', () => {
    const result = paretoFrontier(
      [at('a', 0.9, 1, 0.9), at('b', 0.1, 9, 0.1)],
      ACCURACY,
      { scope: UNDER_SAMPLED },
    );
    expect(result.frontier).toBeNull();
    expect(result.dominated).toEqual([]);
    expect(result.withheld).toEqual({ reason: 'scope-not-scorable', why: UNDER_SAMPLED.why });
    expect(result.separability).toBe(SEPARABILITY_NOT_STATED);
    expect(result.separation).toBe('none');
  });

  it('refuses even the case a point-estimate frontier would call obvious', () => {
    // `a` beats `b` on all three axes by a mile. The scope still cannot support
    // saying nobody should ever buy `b`, because the corpus has too few tasks
    // for anything measured in it to mean that.
    const result = paretoFrontier(
      [at('a', 0.99, 1, 0.99), at('b', 0.01, 99, 0.01)],
      ACCURACY,
      { scope: UNDER_SAMPLED },
    );
    expect(result.withheld?.reason).toBe('scope-not-scorable');
  });
});

describe('a dominance claim on single runs is refused (COMB-41)', () => {
  const thin: CandidateEligibility = {
    scorable: true,
    why: '',
    repetitionsMet: false,
    repetitionsWhy:
      'at least one task in the technical category completed only 1 repetition, below the floor of 3.',
  };

  it('withholds the whole frontier rather than a frontier over the survivors', () => {
    const result = paretoFrontier(
      [
        { ...at('alpha', 0.8, 1, 0.5), eligibility: thin },
        { ...at('beta', 0.801, 1, 0.5), eligibility: thin },
      ],
      ACCURACY,
      SCORABLE,
    );
    expect(result.frontier).toBeNull();
    expect(result.dominated).toEqual([]);
    expect(result.withheld?.reason).toBe('sample-below-spread-floor');
    expect(result.withheld?.why).toMatch(/rank ordering of noise/);
    expect(result.excluded.map((e) => e.id).sort()).toEqual(['alpha', 'beta']);
  });

  it('withholds even when only one candidate is thin, because the lattice is one object', () => {
    const result = paretoFrontier(
      [
        at('sound-a', 0.9, 1, 0.9),
        at('sound-b', 0.5, 2, 0.5),
        { ...at('thin', 0.99, 1, 0.99), eligibility: thin },
      ],
      ACCURACY,
      SCORABLE,
    );
    expect(result.withheld?.reason).toBe('sample-below-spread-floor');
    expect(result.excluded.map((e) => e.id)).toEqual(['thin']);
  });
});

describe('an absent eligibility is refused rather than defaulted (COMB-43)', () => {
  it('withholds when any candidate carries none', () => {
    const bare: FrontierCandidate = { id: 'bare', score: 0.9, costUsd: 1, robustness: 0.9 };
    const result = paretoFrontier([at('known', 0.5, 1, 0.5), bare], ACCURACY, SCORABLE);
    expect(result.frontier).toBeNull();
    expect(result.withheld?.reason).toBe('eligibility-not-supplied');
    expect(result.withheld?.why).toMatch(/"bare"/);
    expect(result.withheld?.why).toMatch(/permissive default/);
  });

  it('names the two verdicts a caller is expected to supply, so the fix is in the message', () => {
    const bare: FrontierCandidate = { id: 'bare', score: 0.9, costUsd: 1, robustness: 0.9 };
    const result = paretoFrontier([bare], ACCURACY, SCORABLE);
    expect(result.withheld?.why).toMatch(/ScorableVerdict/);
    expect(result.withheld?.why).toMatch(/RepetitionFloor/);
  });
});

describe('two is the smallest frontier that says anything (COMB-41, COMB-40)', () => {
  it('withholds a single-candidate frontier rather than calling it undominated', () => {
    const result = paretoFrontier([at('only', 0.9, 1, 0.9)], ACCURACY, SCORABLE);
    expect(result.frontier).toBeNull();
    expect(result.withheld?.reason).toBe('too-few-candidates');
  });

  it('folds a blocked candidate into too-few-candidates, the word rank.ts uses', () => {
    const blocked: CandidateEligibility = {
      scorable: false,
      why: 'gemini completed no technical task, so there is nothing to score.',
      repetitionsMet: true,
      repetitionsWhy: '',
    };
    const result = paretoFrontier(
      [at('ok', 0.9, 1, 0.9), { ...at('blocked', 0.1, 9, 0.1), eligibility: blocked }],
      ACCURACY,
      SCORABLE,
    );
    expect(result.withheld?.reason).toBe('too-few-candidates');
    expect(result.withheld?.why).toContain('nothing to score');
    expect(result.excluded).toEqual([{ id: 'blocked', why: blocked.why }]);
  });
});

describe('a paired comparison decides where it has an answer (COMB-48, COMB-49)', () => {
  it('prefers the injected verdict over the interquartile overlap (COMB-48)', () => {
    // The spreads overlap, so the overlap check alone would tie these two and
    // neither would dominate. The paired test separates them, and it wins.
    const a: FrontierCandidate = { ...at('a', 0.8, 1, 0.5), scoreSpread: spreadOf([0.7, 0.8, 0.9]) };
    const b: FrontierCandidate = { ...at('b', 0.82, 1, 0.5), scoreSpread: spreadOf([0.72, 0.82, 0.92]) };
    const separated: SeparationOracle = () => ({ separated: true, better: 'b' });

    const withOracle = paretoFrontier([a, b], ACCURACY, { ...SCORABLE, separated });
    expect(withOracle.dominated.map((d) => d.id)).toEqual(['a']);
    expect(withOracle.pairs).toEqual({ total: 1, paired: 1, spread: 0, point: 0 });

    const withoutOracle = paretoFrontier([a, b], ACCURACY, SCORABLE);
    expect(withoutOracle.dominated).toEqual([]);
    expect(withoutOracle.pairs.spread).toBe(1);
  });

  it('falls back to the overlap check only where the oracle has no comparison', () => {
    const a: FrontierCandidate = { ...at('a', 0.8, 1, 0.5), scoreSpread: spreadOf([0.7, 0.8, 0.9]) };
    const b: FrontierCandidate = { ...at('b', 0.82, 1, 0.5), scoreSpread: spreadOf([0.72, 0.82, 0.92]) };
    const result = paretoFrontier([a, b], ACCURACY, { ...SCORABLE, separated: () => null });
    expect(result.dominated).toEqual([]);
    expect(result.pairs).toEqual({ total: 1, paired: 0, spread: 1, point: 0 });
  });

  it('ties a pair the oracle refused, rather than handing it back to the weaker check', () => {
    // A comparison that ran the gates and was refused is not the absence of a
    // comparison. `rank.ts` learned this in review and the same rule holds here.
    const a: FrontierCandidate = { ...at('a', 0.2, 1, 0.5), scoreSpread: spreadOf([0.18, 0.2, 0.22]) };
    const b: FrontierCandidate = { ...at('b', 0.9, 1, 0.5), scoreSpread: spreadOf([0.88, 0.9, 0.92]) };
    const result = paretoFrontier([a, b], ACCURACY, {
      ...SCORABLE,
      separated: () => ({ separated: false }),
    });
    expect(result.dominated).toEqual([]);
    expect(result.pairs.paired).toBe(1);
  });

  it('ties when the paired verdict disagrees with the observed values (COMB-49)', () => {
    // The score axis is whatever the injected scorer returned and a paired
    // difference is a mean over per-task differences, so they can disagree. A
    // frontier that ordered them anyway would print a claim its own test
    // contradicts.
    const result = paretoFrontier(
      [at('higher', 0.9, 1, 0.5), at('lower', 0.2, 1, 0.5)],
      ACCURACY,
      { ...SCORABLE, separated: () => ({ separated: true, better: 'lower' }) },
    );
    expect(result.dominated).toEqual([]);
    expect(result.frontier?.map((c) => c.id).sort()).toEqual(['higher', 'lower']);
  });

  it('ties when the verdict names a candidate that is not in the pair', () => {
    const result = paretoFrontier(
      [at('a', 0.9, 1, 0.5), at('b', 0.2, 1, 0.5)],
      ACCURACY,
      { ...SCORABLE, separated: () => ({ separated: true, better: 'somebody-else' }) },
    );
    expect(result.dominated).toEqual([]);
  });

  it('keeps the observed ordering when the verdict separates but names nobody', () => {
    const result = paretoFrontier(
      [at('a', 0.9, 1, 0.5), at('b', 0.2, 1, 0.5)],
      ACCURACY,
      { ...SCORABLE, separated: () => ({ separated: true, better: null }) },
    );
    expect(result.dominated.map((d) => d.id)).toEqual(['b']);
  });

  it('names the paired test in the explanation when it was the one that tied them', () => {
    const result = paretoFrontier(
      [at('cheap', 0.8, 1, 0.5), at('dear', 0.9, 9, 0.5)],
      ACCURACY,
      { ...SCORABLE, separated: () => ({ separated: false }) },
    );
    expect(result.dominated[0]!.why).toMatch(/by the paired difference between them/);
  });
});
