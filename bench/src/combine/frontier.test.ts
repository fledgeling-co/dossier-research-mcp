import { describe, expect, it } from 'vitest';
import {
  paretoFrontier,
  SEPARABILITY_CHECKED,
  SEPARABILITY_UNCHECKED,
  type FrontierCandidate,
  type MeasureLabel,
} from './frontier.js';
import { scoreSpread as spreadOf } from './spread-helpers.js';

const ACCURACY: MeasureLabel = { name: 'accuracy', direction: 'higher-is-better' };
const BRIER: MeasureLabel = { name: 'brier', direction: 'lower-is-better' };

const at = (
  id: string,
  score: number,
  costUsd: number,
  robustness: number,
): FrontierCandidate => ({ id, score, costUsd, robustness });

describe('a dominated combination never reaches the frontier (COMB-24)', () => {
  it('drops one that is worse on every axis at once', () => {
    const good = at('good', 0.9, 1, 0.8);
    const bad = at('bad', 0.5, 5, 0.2);
    const result = paretoFrontier([good, bad], ACCURACY);
    expect(result.frontier.map((c) => c.id)).toEqual(['good']);
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
    );
    expect(result.frontier.map((c) => c.id)).toEqual(['cheap']);
    expect(result.dominated[0]!.why).toMatch(/costs \$1\.00 against \$6\.00/);
  });

  it('names the winner and the axes it won on, because "dominated" alone is not actionable', () => {
    const result = paretoFrontier(
      [at('winner', 0.9, 1, 0.9), at('loser', 0.4, 4, 0.1)],
      ACCURACY,
    );
    const why = result.dominated[0]!.why;
    expect(why).toContain('"winner"');
    expect(why).toContain('accuracy');
    expect(why).toMatch(/no worse on any axis/);
  });
});

describe('domination does not fire on a single-axis win (COMB-25)', () => {
  it('keeps a candidate that scores worse but costs less', () => {
    const result = paretoFrontier(
      [at('strong', 0.9, 5, 0.5), at('cheap', 0.6, 1, 0.5)],
      ACCURACY,
    );
    expect(result.frontier.map((c) => c.id).sort()).toEqual(['cheap', 'strong']);
    expect(result.dominated).toEqual([]);
  });

  it('keeps a candidate that costs more but is more robust', () => {
    const result = paretoFrontier(
      [at('fragile', 0.8, 1, 0.1), at('sturdy', 0.8, 2, 0.9)],
      ACCURACY,
    );
    expect(result.dominated).toEqual([]);
  });

  it('keeps a candidate that is less robust but scores higher', () => {
    const result = paretoFrontier(
      [at('sharp', 0.95, 1, 0.2), at('steady', 0.7, 1, 0.95)],
      ACCURACY,
    );
    expect(result.dominated).toEqual([]);
  });
});

describe('ties on all three keep both (COMB-26)', () => {
  it('does not pick a winner by input order', () => {
    const result = paretoFrontier([at('a', 0.8, 2, 0.5), at('b', 0.8, 2, 0.5)], ACCURACY);
    expect(result.frontier.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(result.dominated).toEqual([]);
  });
});

describe('the third axis earns its place (COMB-27)', () => {
  it('keeps a dearer combination that is better on score and robustness', () => {
    // Two axes would call this a straight trade and could not say which is
    // better. Three axes say it: `sturdy` wins on two and loses on one, so both
    // stay, and the reader sees the trade instead of a fabricated ordering.
    const result = paretoFrontier(
      [at('cheap', 0.70, 1, 0.30), at('sturdy', 0.85, 3, 0.90)],
      ACCURACY,
    );
    expect(result.dominated).toEqual([]);
  });

  it('lets robustness alone decide domination when score and cost tie', () => {
    // This is the case the brief says a two-axis frontier cannot express: same
    // score, same price, one survives losing a member better.
    const result = paretoFrontier(
      [at('brittle', 0.8, 2, 0.10), at('resilient', 0.8, 2, 0.90)],
      ACCURACY,
    );
    expect(result.frontier.map((c) => c.id)).toEqual(['resilient']);
    expect(result.dominated[0]!.why).toMatch(/survives losing a member with 90\.0%/);
  });
});

describe('the axis shape is closed (COMB-28)', () => {
  it('carries exactly three comparison axes, and none of them is overlap', () => {
    const result = paretoFrontier([at('a', 1, 1, 1)], ACCURACY);
    expect(Object.keys(result.axes).sort()).toEqual(['costUsd', 'robustness', 'score']);
    // Overlap has no field here, which is the enforcement rather than the
    // convention: an axis IS a direction, and the brief says overlap must not
    // be given one.
    expect(Object.keys(result.axes)).not.toContain('overlap');
    const candidateKeys = Object.keys(result.frontier[0]!);
    expect(candidateKeys).not.toContain('overlap');
    expect(candidateKeys).not.toContain('meanUrlJaccard');
  });

  it('states the direction of every axis rather than leaving it to be guessed', () => {
    const result = paretoFrontier([at('a', 1, 1, 1)], ACCURACY);
    expect(result.axes).toEqual({
      score: 'maximise',
      costUsd: 'minimise',
      robustness: 'maximise',
    });
  });
});

describe('the score axis is named and directed (COMB-33)', () => {
  it('refuses an unnamed measure', () => {
    expect(() => paretoFrontier([at('a', 1, 1, 1)], { name: '  ', direction: 'higher-is-better' })).toThrow(
      /named measure/i,
    );
  });

  it('carries the measure onto the result', () => {
    expect(paretoFrontier([at('a', 1, 1, 1)], ACCURACY).measure).toEqual(ACCURACY);
  });

  it('inverts a lower-is-better measure once, so the best Brier score wins', () => {
    // Unflipped, this would rank the worst-calibrated combination first and
    // nothing downstream could tell.
    const result = paretoFrontier(
      [at('well-calibrated', 0.05, 1, 0.5), at('badly-calibrated', 0.40, 1, 0.5)],
      BRIER,
    );
    expect(result.frontier.map((c) => c.id)).toEqual(['well-calibrated']);
    expect(result.dominated[0]!.id).toBe('badly-calibrated');
  });

  it('reports the score back in the caller units, never negated', () => {
    const result = paretoFrontier(
      [at('good', 0.05, 1, 0.5), at('bad', 0.40, 1, 0.5)],
      BRIER,
    );
    expect(result.frontier[0]!.score).toBe(0.05);
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
      expect(() => paretoFrontier([bad], ACCURACY)).toThrow(/finite number/i);
    }
  });

  it('says why, because a NaN compares false against everything', () => {
    expect(() => paretoFrontier([at('x', Number.NaN, 1, 1)], ACCURACY)).toThrow(
      /reported as undominated no matter how bad/i,
    );
  });

  it('refuses two candidates sharing an id', () => {
    expect(() => paretoFrontier([at('same', 1, 1, 1), at('same', 0, 2, 0)], ACCURACY)).toThrow(
      /share the id/i,
    );
  });
});

describe('what the sample can support (COMB-34)', () => {
  it('treats overlapping score spreads as a tie, so neither dominates', () => {
    // 0.80 against 0.82 with spreads that overlap heavily. A point-estimate
    // frontier would call the second dominant and say nobody should buy the
    // first, which is a claim this sample cannot carry.
    const a: FrontierCandidate = {
      ...at('a', 0.80, 1, 0.5),
      scoreSpread: spreadOf([0.70, 0.80, 0.90]),
    };
    const b: FrontierCandidate = {
      ...at('b', 0.82, 1, 0.5),
      scoreSpread: spreadOf([0.72, 0.82, 0.92]),
    };
    const result = paretoFrontier([a, b], ACCURACY);
    expect(result.frontier.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(result.dominated).toEqual([]);
  });

  it('still separates them when the spreads do not overlap', () => {
    const a: FrontierCandidate = {
      ...at('weak', 0.20, 1, 0.5),
      scoreSpread: spreadOf([0.18, 0.20, 0.22]),
    };
    const b: FrontierCandidate = {
      ...at('strong', 0.90, 1, 0.5),
      scoreSpread: spreadOf([0.88, 0.90, 0.92]),
    };
    const result = paretoFrontier([a, b], ACCURACY);
    expect(result.frontier.map((c) => c.id)).toEqual(['strong']);
    expect(result.dominated[0]!.id).toBe('weak');
  });

  it('does not let an unestablished score difference rescue a candidate either', () => {
    // Tied on score by overlap, but strictly dearer: still dominated, on cost.
    const a: FrontierCandidate = {
      ...at('cheap', 0.80, 1, 0.5),
      scoreSpread: spreadOf([0.70, 0.80, 0.90]),
    };
    const b: FrontierCandidate = {
      ...at('dear', 0.82, 9, 0.5),
      scoreSpread: spreadOf([0.72, 0.82, 0.92]),
    };
    const result = paretoFrontier([a, b], ACCURACY);
    expect(result.frontier.map((c) => c.id)).toEqual(['cheap']);
    expect(result.dominated[0]!.why).toMatch(/cannot be separated on accuracy/);
  });

  it('says which of the two claims it is making', () => {
    const withSpread: FrontierCandidate = {
      ...at('a', 0.8, 1, 0.5),
      scoreSpread: spreadOf([0.7, 0.8, 0.9]),
    };
    expect(paretoFrontier([withSpread], ACCURACY).separability).toBe(SEPARABILITY_CHECKED);
    expect(paretoFrontier([at('a', 0.8, 1, 0.5)], ACCURACY).separability).toBe(
      SEPARABILITY_UNCHECKED,
    );
    // The unchecked sentence has to admit what it is rather than stay silent.
    expect(SEPARABILITY_UNCHECKED).toMatch(/point-estimate/i);
    expect(SEPARABILITY_CHECKED).toMatch(/not a significance test/i);
  });
});
