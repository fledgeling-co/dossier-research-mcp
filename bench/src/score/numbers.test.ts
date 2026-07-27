import { describe, expect, it } from 'vitest';
import { normaliseForSearch } from './confidence.js';
import {
  isZeroWidthTolerance,
  readNumbers,
  shiftDecimal,
  toPlainString,
  withinTolerance,
  type NumberMention,
} from './numbers.js';
import type { Tolerance } from '../tasks/schema.js';

/**
 * The table-driven half of this item, because the brief says so: number
 * formatting is where the silent false negatives live, and a case missed here
 * is a backend reported as worse than it is with nothing in the output to say
 * why.
 */

const say = (text: string, forms: readonly string[] = []): NumberMention[] =>
  readNumbers(normaliseForSearch(text), forms);

/** Does any reading of any mention equal this value with this unit? */
function has(
  mentions: readonly NumberMention[],
  value: number,
  unit: string | null = null,
): boolean {
  return mentions.some((m) =>
    m.readings.some((r) => Object.is(r.value, value) && r.unit === unit),
  );
}

describe('toPlainString (ACCREL-10)', () => {
  it('never returns exponential notation', () => {
    // Both spellings JavaScript reaches for above 1e21 are exponential, which is
    // the trap the gold-verification module already hit once in this repo.
    expect(String(1e21)).toContain('e+');
    expect((1e21).toFixed(0)).toContain('e+');
    expect(toPlainString(1e21)).toBe('1000000000000000000000');
  });

  it.each([
    [0, '0'],
    [8.8, '8.8'],
    [-8.8, '-8.8'],
    [1200000000, '1200000000'],
    [1e-7, '0.0000001'],
    [1.5e-7, '0.00000015'],
    [1.2e21, '1200000000000000000000'],
    [-3e22, '-30000000000000000000000'],
  ])('writes %p as %p', (value, expected) => {
    expect(toPlainString(value)).toBe(expected);
  });
});

describe('shiftDecimal (ACCREL-10)', () => {
  it('is exact where multiplication is not', () => {
    // The whole reason this function exists rather than `value * 10 ** e`. Each
    // of these is a figure a report plausibly writes, and each lands off the
    // exact answer by multiplication, enough to fail an `exact` tolerance for
    // reasons having nothing to do with research. The cases were found by
    // sweep rather than guessed; an earlier version of this test asserted
    // `1.1 * 1e6` was inexact, which it is not.
    expect(1.005 * 1e6).not.toBe(1_005_000);
    expect(shiftDecimal('1.005', 6)).toBe(1_005_000);

    expect(0.267 * 1e9).not.toBe(267_000_000);
    expect(shiftDecimal('0.267', 9)).toBe(267_000_000);

    expect(2.01 * 1e3).not.toBe(2010);
    expect(shiftDecimal('2.01', 3)).toBe(2010);

    expect(0.067 * 1e12).not.toBe(67_000_000_000);
    expect(shiftDecimal('0.067', 12)).toBe(67_000_000_000);
  });

  it.each([
    ['1.2', 9, 1200000000],
    ['1.2', 0, 1.2],
    ['450', 6, 450000000],
    ['8.8', 3, 8800],
    ['-2.5', 6, -2500000],
    ['0.5', 3, 500],
    ['1', 12, 1000000000000],
  ])('shifts %s by %i to %p', (text, exponent, expected) => {
    expect(shiftDecimal(text, exponent)).toBe(expected);
  });
});

describe('the ways a model writes one figure (ACCREL-01)', () => {
  // Every row states the same fact: 1.2 billion US dollars.
  const TARGET = 1_200_000_000;

  it.each([
    ['1.2 billion', null],
    ['1.2 Billion', null],
    ['1,200,000,000', null],
    ['1200000000', null],
    ['1.2B', null],
    ['1.2b', null],
    ['1.2bn', null],
    ['1.2 bn', null],
    ['1.2 BN', null],
    ['1.2e9', null],
    ['1200 million', null],
  ])('reads %s as the figure', (text) => {
    expect(has(say(text), TARGET)).toBe(true);
  });

  it.each([
    ['$1.2B', 'usd'],
    ['$1.2 billion', 'usd'],
    ['US$1.2bn', 'usd'],
    ['USD 1.2 billion', 'usd'],
    ['1.2 billion dollars', 'usd'],
    ['1.2 billion USD', 'usd'],
    ['$1,200,000,000', 'usd'],
  ])('reads %s as the figure in %s', (text, unit) => {
    expect(has(say(text), TARGET, unit)).toBe(true);
  });

  it.each([
    ['28.6%', 28.6, 'percent'],
    ['28.6 %', 28.6, 'percent'],
    ['28.6 percent', 28.6, 'percent'],
    ['28.6 per cent', 28.6, 'percent'],
    ['28.6 pct', 28.6, 'percent'],
    ['8.8', 8.8, null],
    ['303 questions', 303, null],
    ['-3.5%', -3.5, 'percent'],
    ['−3.5%', -3.5, 'percent'],
  ])('reads %s as %p in %s', (text, value, unit) => {
    expect(has(say(text), value, unit)).toBe(true);
  });

  it('recognises an author unit only when its forms are supplied', () => {
    expect(has(say('303 questions'), 303, 'question')).toBe(false);
    expect(has(say('303 questions', ['question', 'questions']), 303, 'question')).toBe(true);
  });
});

describe('an ambiguous suffix is read both ways (ACCREL-05)', () => {
  it('reads 450m as 450 million and as 450 metres', () => {
    const mentions = say('the tunnel is 450m');
    expect(has(mentions, 450_000_000)).toBe(true);
    expect(has(mentions, 450, 'metre')).toBe(true);
  });

  it('gives a spelled-out scale word exactly one reading', () => {
    const readings = say('450 million').flatMap((m) => m.readings);
    expect(readings).toHaveLength(1);
    expect(readings[0]?.value).toBe(450_000_000);
  });

  it('reads 2t as 2 trillion and as 2 tonnes', () => {
    const mentions = say('2t');
    expect(has(mentions, 2_000_000_000_000)).toBe(true);
    expect(has(mentions, 2, 'tonne')).toBe(true);
  });
});

describe('what is deliberately not parsed', () => {
  it('does not read a European thousands separator as grouping', () => {
    // Documented rather than supported: reports under test are English, and
    // guessing a locale would silently change the meaning of `1.200`.
    expect(has(say('1.200.000'), 1_200_000)).toBe(false);
    expect(has(say('1.200.000'), 1.2)).toBe(true);
  });

  it('reads no number at all out of a date shape', () => {
    // The whole run is masked before scanning. Without it a gold of 7 would be
    // recovered from a publication date, because an unstated unit is compatible
    // with any gold unit. The same rule the due-weight scorer reached
    // independently, and for the same reason.
    expect(say('published 2026-07-01')).toHaveLength(0);
    expect(say('published 8 July 2026')).toHaveLength(0);
    expect(say('published July 8, 2026')).toHaveLength(0);
    expect(say('published 01/07/2026')).toHaveLength(0);
  });

  it('leaves a range alone, which shares a date shape at the hyphen', () => {
    // `2026-07-27` and `50-60%` look the same at the hyphen, so the mask covers
    // whole shapes only. Both numbers in a range are real.
    expect(has(say('between 50-60%'), 50, 'percent') || has(say('between 50-60%'), 50)).toBe(true);
    expect(has(say('between 50-60%'), 60, 'percent')).toBe(true);
  });

  it('masks without moving any other offset', () => {
    const text = 'on 2026-07-01 the score was 8.8';
    const mention = say(text)[0];
    expect(mention?.readings[0]?.value).toBe(8.8);
    // The mask is length-preserving, so the index still points at the real text.
    expect(text.slice(mention?.start ?? 0, (mention?.start ?? 0) + 3)).toBe('8.8');
  });

  it('does not let a scale letter attach to the word after it', () => {
    // `market` must not be read as the `m` multiplier.
    const readings = say('450 market share').flatMap((r) => r.readings);
    expect(readings.every((r) => r.value === 450)).toBe(true);
  });
});

describe('withinTolerance (ACCREL-09)', () => {
  const exact: Tolerance = { kind: 'exact' };
  const absolute: Tolerance = { kind: 'absolute', value: 0.5 };
  const relative: Tolerance = { kind: 'relative', fraction: 0.01 };
  const sig: Tolerance = { kind: 'significantFigures', digits: 3 };

  it('exact is strict equality, with no hidden width', () => {
    // An earlier draft allowed a 1e-12 relative guard "for float noise". The
    // out-of-family review was right that it is a tolerance in disguise: it
    // accepted a reported 0 for a gold of 1e-13. Strict equality is safe only
    // because both sides are parsed decimal-safely, which is the invariant the
    // shiftDecimal cases above protect.
    expect(withinTolerance(8.8, 8.8, exact)).toBe(true);
    expect(withinTolerance(shiftDecimal('1.005', 6), 1_005_000, exact)).toBe(true);
    expect(withinTolerance(8.81, 8.8, exact)).toBe(false);
    expect(withinTolerance(0, 1e-13, exact)).toBe(false);
    expect(withinTolerance(1e-12, 0, exact)).toBe(false);
    expect(withinTolerance(0.1 + 0.2, 0.3, exact)).toBe(false);
  });

  it.each([
    [100.5, true],
    [99.5, true],
    [100.51, false],
    [99.49, false],
  ])('absolute accepts %p as %p', (reported, expected) => {
    expect(withinTolerance(reported, 100, absolute)).toBe(expected);
  });

  it.each([
    [101, true],
    [99, true],
    [101.01, false],
    [98.99, false],
  ])('relative accepts %p as %p', (reported, expected) => {
    expect(withinTolerance(reported, 100, relative)).toBe(expected);
  });

  it('a relative tolerance against a zero gold has no width', () => {
    expect(withinTolerance(0, 0, relative)).toBe(true);
    expect(withinTolerance(0.0001, 0, relative)).toBe(false);
    expect(isZeroWidthTolerance(0, relative)).toBe(true);
    expect(isZeroWidthTolerance(1, relative)).toBe(false);
    expect(isZeroWidthTolerance(0, exact)).toBe(false);
  });

  it.each([
    [1_230_000, true],
    [1_234_999, true],
    [1_240_000, false],
  ])('three significant figures accepts %p as %p', (reported, expected) => {
    expect(withinTolerance(reported, 1_234_567, sig)).toBe(expected);
  });

  it('refuses a value that is not a finite number', () => {
    expect(withinTolerance(Number.NaN, 1, exact)).toBe(false);
    expect(withinTolerance(Number.POSITIVE_INFINITY, 1, exact)).toBe(false);
  });
});

describe('no output carries exponential notation (ACCREL-10)', () => {
  it('holds across every mention this module produces for a huge figure', () => {
    const mentions = say('the figure was 1.2 sextillion, or 1.2e21 exactly');
    for (const mention of mentions) {
      for (const reading of mention.readings) {
        expect(toPlainString(reading.value)).not.toMatch(/e[+-]/i);
      }
    }
  });
});
