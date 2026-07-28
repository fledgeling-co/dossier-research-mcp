import { describe, expect, it } from 'vitest';
import { OVERLAP_NOTE, PAIRED_NOTE, rankBackends, type RankCandidate } from './rank.js';
import { summarise } from './spread.js';

function candidate(
  provider: string,
  values: readonly number[],
  completed = values.length,
  unit: 'repetition' | 'task' = 'task',
): RankCandidate {
  return {
    provider,
    value: summarise(values, completed, unit),
    scorable: true,
    why: '',
    completionRate: 1,
    repetitionsMet: true,
    repetitionsWhy: 'the fixture ran enough repetitions',
  };
}

const OVERALL = { kind: 'overall' } as const;

describe('REPORT-01 at one repetition, numbers and no ranking', () => {
  it('withholds when every candidate has a single result', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('gemini', [0.9], 1),
      candidate('openai', [0.4], 1),
    ]);
    expect(ranking.entries).toBeNull();
    expect(ranking.withheld).toBe('sample-below-spread-floor');
  });

  it('withholds even when one backend has plenty, because the other cannot be placed', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('gemini', [0.9, 0.91, 0.92]),
      candidate('openai', [0.4], 1),
    ]);
    expect(ranking.entries).toBeNull();
    expect(ranking.withheld).toBe('sample-below-spread-floor');
    expect(ranking.excluded.map((e) => e.provider)).toContain('openai');
  });
});

describe('REPORT-02 a withheld ranking names the condition that failed', () => {
  it('names the spread floor and what it needed', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('a', [0.5], 1),
      candidate('b', [0.6], 1),
    ]);
    expect(ranking.note).toMatch(/too few results for a spread/);
    expect(ranking.note).toMatch(/The floor is 3 results/);
    expect(ranking.note).toMatch(/confident ranking it cannot support/);
  });

  it('names the unrankable metric and its family', () => {
    const ranking = rankBackends('citation-sources', OVERALL, [
      candidate('a', [10, 11, 12]),
      candidate('b', [90, 91, 92]),
    ]);
    expect(ranking.entries).toBeNull();
    expect(ranking.withheld).toBe('metric-not-rankable');
    expect(ranking.note).toMatch(/volume figure and is never ordered/);
  });

  it('names an unscorable scope before it looks at any sample', () => {
    const ranking = rankBackends(
      'accuracy',
      { kind: 'category', category: 'contested' },
      [candidate('a', [0.5, 0.6, 0.7]), candidate('b', [0.1, 0.2, 0.3])],
      false,
    );
    expect(ranking.entries).toBeNull();
    expect(ranking.withheld).toBe('scope-not-scorable');
    expect(ranking.note).toMatch(/too few tasks/);
  });

  it('refuses to call one backend a ranking', () => {
    const ranking = rankBackends('accuracy', OVERALL, [candidate('a', [0.5, 0.6, 0.7])]);
    expect(ranking.entries).toBeNull();
    expect(ranking.withheld).toBe('too-few-candidates');
    expect(ranking.note).toMatch(/not a comparison/);
  });

  it('excludes a backend the scope cannot score, naming its reason', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('a', [0.5, 0.6, 0.7]),
      candidate('b', [0.1, 0.2, 0.3]),
      { provider: 'c', value: null, scorable: false, why: 'c completed nothing', completionRate: 0, repetitionsMet: false, repetitionsWhy: 'nothing ran' },
    ]);
    expect(ranking.excluded).toContainEqual({ provider: 'c', why: 'c completed nothing' });
    expect(ranking.entries?.map((e) => e.provider)).toEqual(['a', 'b']);
  });
});

describe('REPORT-19 and REPORT-20 the ordering itself', () => {
  it('orders a higher-is-better metric best first', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('low', [0.1, 0.11, 0.12]),
      candidate('high', [0.9, 0.91, 0.92]),
    ]);
    expect(ranking.entries?.map((e) => e.provider)).toEqual(['high', 'low']);
    expect(ranking.entries?.map((e) => e.rank)).toEqual([1, 2]);
  });

  it('orders the Brier score ascending, because lower is better there', () => {
    const ranking = rankBackends('calibration-brier', OVERALL, [
      candidate('worse', [0.8, 0.81, 0.82]),
      candidate('better', [0.1, 0.11, 0.12]),
    ]);
    expect(ranking.entries?.map((e) => e.provider)).toEqual(['better', 'worse']);
  });

  it('calls two overlapping spreads tied rather than ordering them', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('a', [0.1, 0.5, 0.9]),
      candidate('b', [0.2, 0.55, 0.95]),
    ]);
    const entries = ranking.entries ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[1]?.tiedWithPrevious).toBe(true);
    expect(entries.map((e) => e.rank)).toEqual([1, 1]);
  });

  it('uses competition ranking, so a third clear of a tied pair is rank 3', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('a', [0.80, 0.85, 0.90]),
      candidate('b', [0.78, 0.84, 0.88]),
      candidate('c', [0.01, 0.02, 0.03]),
    ]);
    expect(ranking.entries?.map((e) => e.rank)).toEqual([1, 1, 3]);
  });

  it('says on every stated ranking that the overlap check is not a significance test', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('a', [0.9, 0.91, 0.92]),
      candidate('b', [0.1, 0.11, 0.12]),
    ]);
    expect(ranking.note).toBe(OVERLAP_NOTE);
    expect(ranking.note).toMatch(/not a significance test/);
    expect(ranking.note).toMatch(/BENCH-13/);
  });

  it('breaks a genuine value tie by name, so the order is deterministic', () => {
    const first = rankBackends('accuracy', OVERALL, [
      candidate('zeta', [0.5, 0.5, 0.5]),
      candidate('alpha', [0.5, 0.5, 0.5]),
    ]);
    const second = rankBackends('accuracy', OVERALL, [
      candidate('alpha', [0.5, 0.5, 0.5]),
      candidate('zeta', [0.5, 0.5, 0.5]),
    ]);
    expect(first.entries?.map((e) => e.provider)).toEqual(['alpha', 'zeta']);
    expect(second.entries?.map((e) => e.provider)).toEqual(['alpha', 'zeta']);
  });

  it('carries the completion rate onto every ranked entry', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      { ...candidate('a', [0.9, 0.91, 0.92]), completionRate: 0.5 },
      { ...candidate('b', [0.1, 0.11, 0.12]), completionRate: 1 },
    ]);
    expect(ranking.entries?.map((e) => e.completionRate)).toEqual([0.5, 1]);
  });
});

describe('a candidate with no value never enters the ordering', () => {
  it('excludes it and says so', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('a', [0.9, 0.91, 0.92]),
      candidate('b', [0.1, 0.11, 0.12]),
      { provider: 'c', value: null, scorable: true, why: '', completionRate: 1, repetitionsMet: true, repetitionsWhy: '' },
    ]);
    expect(ranking.entries?.map((e) => e.provider)).toEqual(['a', 'b']);
    expect(ranking.excluded.map((e) => e.provider)).toEqual(['c']);
  });
});

describe('a metric nobody measured is not a sample problem', () => {
  it('says the metric was never measured, rather than counting zero candidates', () => {
    const ranking = rankBackends('refusal', OVERALL, [
      { provider: 'a', value: null, scorable: true, why: '', completionRate: 1, repetitionsMet: true, repetitionsWhy: '' },
      { provider: 'b', value: null, scorable: true, why: '', completionRate: 1, repetitionsMet: true, repetitionsWhy: '' },
    ]);
    expect(ranking.withheld).toBe('metric-not-measured');
    expect(ranking.note).toMatch(/never measured here, not a sample too small/);
  });

  it('counts the spread shortfall against the backends that had a value', () => {
    const ranking = rankBackends('accuracy', OVERALL, [
      candidate('a', [0.5], 1),
      candidate('b', [0.6], 1),
      { provider: 'c', value: null, scorable: false, why: 'c ran nothing', completionRate: 0, repetitionsMet: false, repetitionsWhy: 'nothing ran' },
    ]);
    expect(ranking.note).toMatch(/Of the 2 backends with a value/);
  });
});

describe('STAT-17 a paired verdict decides the tie where one exists', () => {
  it('separates two backends whose spreads overlap, when the paired test measured a difference', () => {
    // Overlapping interquartile ranges. The old rule ties these; the paired
    // test, which uses the pairing the overlap check throws away, does not.
    const ranking = rankBackends(
      'accuracy',
      OVERALL,
      [candidate('gemini', [0.5, 0.6, 0.7]), candidate('openai', [0.45, 0.55, 0.65])],
      true,
      () => 'separated',
    );
    expect(ranking.entries?.map((e) => e.rank)).toEqual([1, 2]);
    expect(ranking.entries?.[1]?.tiedWithPrevious).toBe(false);
    expect(ranking.separation).toBe('paired');
    expect(ranking.note).toBe(PAIRED_NOTE);
  });

  it('ties two backends whose spreads do not overlap, when the interval crosses zero', () => {
    const ranking = rankBackends(
      'accuracy',
      OVERALL,
      [candidate('gemini', [0.9, 0.91, 0.92]), candidate('openai', [0.1, 0.11, 0.12])],
      true,
      () => 'tied',
    );
    expect(ranking.entries?.map((e) => e.rank)).toEqual([1, 1]);
    expect(ranking.entries?.[1]?.tiedWithPrevious).toBe(true);
    expect(ranking.separation).toBe('paired');
  });

  it('falls back to overlap where the oracle has no answer, and says which ran', () => {
    const withNoAnswer = rankBackends(
      'accuracy',
      OVERALL,
      [candidate('gemini', [0.9, 0.91, 0.92]), candidate('openai', [0.1, 0.11, 0.12])],
      true,
      () => null,
    );
    const withNoOracle = rankBackends('accuracy', OVERALL, [
      candidate('gemini', [0.9, 0.91, 0.92]),
      candidate('openai', [0.1, 0.11, 0.12]),
    ]);
    expect(withNoAnswer.entries).toEqual(withNoOracle.entries);
    expect(withNoAnswer.separation).toBe('overlap');
    expect(withNoAnswer.note).toBe(OVERLAP_NOTE);
  });

  it('names no separation check on a withheld ranking', () => {
    const ranking = rankBackends('citation-sources', OVERALL, []);
    expect(ranking.separation).toBe('none');
  });

  it('keeps both notes honest about what they are', () => {
    expect(OVERLAP_NOTE).toMatch(/not a significance test/);
    expect(PAIRED_NOTE).toMatch(/excludes zero/);
    expect(PAIRED_NOTE).toMatch(/resampled as units/);
  });
});
