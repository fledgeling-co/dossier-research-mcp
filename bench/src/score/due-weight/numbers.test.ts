import { describe, expect, it } from 'vitest';
import type { Tolerance } from '../../tasks/schema.js';
import {
  extractNumericMentions,
  findMatchingMention,
  maskDateShapes,
  matchesTolerance,
} from './numbers.js';
import { normaliseForMatch } from './text.js';

/**
 * Finding a figure in prose.
 *
 * Both error directions are tested on purpose, because they cost different
 * things. A missed figure reports an honest backend as one-sided. A spurious
 * figure credits a report for disclosing a disagreement it never mentioned, and
 * that is the worse one, because it makes the metric report the failure it
 * exists to catch as a success.
 */

const EXACT: Tolerance = { kind: 'exact' };

/** Values only, which is what almost every assertion here is about. */
function values(text: string): number[] {
  return extractNumericMentions(normaliseForMatch(text)).map((m) => m.value);
}

describe('extractNumericMentions', () => {
  it('reads the forms a report actually writes one figure in', () => {
    expect(values('1200000000')).toEqual([1200000000]);
    expect(values('1,200,000,000')).toEqual([1200000000]);
    expect(values('1.2 billion')).toEqual([1200000000]);
    expect(values('$1.2bn')).toEqual([1200000000]);
    expect(values('US$1.2 billion')).toEqual([1200000000]);
    expect(values('1.2e9')).toEqual([1200000000]);
  });

  it('reads every magnitude word and its attached abbreviation', () => {
    expect(values('4 thousand')).toEqual([4000]);
    expect(values('4k')).toEqual([4000]);
    expect(values('4 million')).toEqual([4000000]);
    expect(values('4m')).toEqual([4000000]);
    expect(values('4mn')).toEqual([4000000]);
    expect(values('4 trillion')).toEqual([4000000000000]);
    expect(values('4tn')).toEqual([4000000000000]);
  });

  it('takes an abbreviation only when attached, because a spaced one is ambiguous', () => {
    // `5 m` is metres far more often than five million; `$1.2bn` is never
    // anything else. The asymmetry is deliberate.
    expect(values('5 m of cable')).toEqual([5]);
    expect(values('5m of revenue')).toEqual([5000000]);
  });

  // DUEWT-16
  it('does not fire inside a date, a version, an ordinal or a decade', () => {
    expect(values('filed on 2026-07-27 and again')).toEqual([]);
    expect(values('filed on 07/27/2026 and again')).toEqual([]);
    expect(values('the 2026-07 quarter')).toEqual([]);
    expect(values('v1.2.3 shipped')).toEqual([]);
    expect(values('the 3rd time')).toEqual([]);
    expect(values('through the 1980s')).toEqual([]);
    expect(values('12,34 is a typo')).toEqual([]);
  });

  // DUEWT-16
  it('does not read a unit suffix as a magnitude', () => {
    expect(values('5km away')).toEqual([]);
    expect(values('300mb of data')).toEqual([]);
  });

  it('keeps both sides of a range, which is how a report writes two clashing figures', () => {
    // The local rule that would drop `2026-07-27` also drops `50-60%`, which is
    // why dates are masked as whole shapes instead.
    expect(values('1150-1200')).toEqual([1150, 1200]);
    expect(values('50-60%')).toEqual([50, 60]);
    expect(values('1,200,000,000-1,300,000,000')).toEqual([1200000000, 1300000000]);
    expect(values('between 2026-2030')).toEqual([2026, 2030]);
  });

  it('reads a genuine minus but not a hyphen between digits', () => {
    expect(values('it fell to -3.5 degrees')).toEqual([-3.5]);
    expect(values('the 1150-1200 band')).toEqual([1150, 1200]);
  });

  it('records a percentage at face value and says it was one', () => {
    const mentions = extractNumericMentions(normaliseForMatch('growth of 28.6% year on year'));
    expect(mentions[0]?.value).toBe(28.6);
    expect(mentions[0]?.percent).toBe(true);
    expect(extractNumericMentions(normaliseForMatch('28.6 points'))[0]?.percent).toBe(false);
  });

  it('quotes the span as the report wrote it, not as the matcher saw it', () => {
    const mentions = extractNumericMentions(normaliseForMatch('revenue of 1.2 BILLION dollars'));
    expect(mentions[0]?.text).toBe('1.2 billion');
  });

  // DUEWT-17
  it('applies a magnitude by shifting the decimal point, where multiplying would miss', () => {
    // Measured, not assumed: 1.07 * 1e9 is 1070000000.0000001, so a report that
    // stated the gold value perfectly would fail an exact tolerance.
    expect(1.07 * 1e9).not.toBe(1070000000);
    expect(2.01 * 1e3).not.toBe(2010);
    expect(values('1.07 billion')).toEqual([1070000000]);
    expect(values('2.01 thousand')).toEqual([2010]);
    expect(matchesTolerance(values('1.07 billion')[0] ?? NaN, 1070000000, EXACT)).toBe(true);
  });

  it('ignores a magnitude word after an exponent rather than guessing which was meant', () => {
    expect(values('1.2e9 billion')).toEqual([1200000000]);
  });

  it('reads a long mixed passage in order and terminates', () => {
    const passage =
      'On 2026-07-27, v2.1.0 reported 1,150,000,000 against an earlier 1.2 billion, ' +
      'a gap of 4.3% across 3 filings and the 1990s.';
    expect(values(passage)).toEqual([1150000000, 1200000000, 4.3, 3]);
  });

  it('returns nothing rather than throwing on text with no numbers', () => {
    expect(values('')).toEqual([]);
    expect(values('no figures here at all')).toEqual([]);
  });
});

describe('maskDateShapes', () => {
  it('preserves length, so every other offset in the scorer stays valid', () => {
    const text = 'filed 2026-07-27 and 07/27/2026';
    expect(maskDateShapes(text)).toHaveLength(text.length);
  });

  it('masks a whole date and never a range of years', () => {
    expect(maskDateShapes('2026-07-27')).toBe('##########');
    expect(maskDateShapes('2026-2030')).toBe('2026-2030');
    // 13 is not a month, so this is a range and both numbers are real.
    expect(maskDateShapes('2026-13')).toBe('2026-13');
  });
});

describe('matchesTolerance', () => {
  // DUEWT-18
  it('exact rejects a neighbouring value', () => {
    expect(matchesTolerance(100, 100, EXACT)).toBe(true);
    expect(matchesTolerance(100.0001, 100, EXACT)).toBe(false);
  });

  // DUEWT-18
  it('absolute accepts at its boundary and rejects beyond it', () => {
    const t: Tolerance = { kind: 'absolute', value: 0.5 };
    expect(matchesTolerance(100.5, 100, t)).toBe(true);
    expect(matchesTolerance(99.5, 100, t)).toBe(true);
    expect(matchesTolerance(100.6, 100, t)).toBe(false);
  });

  // DUEWT-18
  it('relative reads its payload as a fraction, never as a percentage', () => {
    const t: Tolerance = { kind: 'relative', fraction: 0.01 };
    expect(matchesTolerance(101, 100, t)).toBe(true);
    expect(matchesTolerance(102, 100, t)).toBe(false);
  });

  // DUEWT-18
  it('significant figures accepts a correctly rounded value', () => {
    const t: Tolerance = { kind: 'significantFigures', digits: 3 };
    expect(matchesTolerance(1234567, 1230000, t)).toBe(true);
    expect(matchesTolerance(1240000, 1230000, t)).toBe(false);
    expect(matchesTolerance(0, 0, t)).toBe(true);
  });

  it('never matches a non-finite value, and says no for that reason rather than by accident', () => {
    expect(matchesTolerance(NaN, 100, EXACT)).toBe(false);
    expect(matchesTolerance(Infinity, 100, { kind: 'absolute', value: 1e308 })).toBe(false);
    expect(matchesTolerance(100, NaN, EXACT)).toBe(false);
  });
});

describe('findMatchingMention', () => {
  it('returns the first mention within tolerance, or null', () => {
    const mentions = extractNumericMentions(normaliseForMatch('either 1.15 billion or 1.2 billion'));
    expect(findMatchingMention(mentions, 1200000000, EXACT)?.text).toBe('1.2 billion');
    expect(findMatchingMention(mentions, 999, EXACT)).toBeNull();
  });
});
