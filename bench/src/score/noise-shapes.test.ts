import { describe, expect, it } from 'vitest';
import { maskDateShapes, MONTH_NAMES, NOISE_FILL, NOISE_SHAPE_SOURCES } from './noise-shapes.js';

/**
 * The one date mask, and the union it is.
 *
 * BENCH-04 and BENCH-05 each wrote one of these and each missed exactly what
 * the other caught. Every row below names which author wanted the shape, so the
 * union is checkable rather than asserted, and the two decisions that were not a
 * union (the fill character and the month pattern) have their own cases.
 */

/** Whatever survives the mask, which is what the readers downstream will see. */
const kept = (text: string): string => maskDateShapes(text);

/** Whether the whole input was blanked. */
const blanked = (text: string): boolean =>
  maskDateShapes(text) === NOISE_FILL.repeat(text.length);

describe('the mask is length-preserving, which every downstream offset depends on', () => {
  // DUP-03
  it('returns one fill character per source character, on every shape', () => {
    for (const text of [
      'filed 2026-07-27 and 07/27/2026',
      'as of 2026-07-27T10:30:00Z',
      'see https://example.test/a/1234567 for detail',
      'on July  8,  2026 the filing landed',
      'in 2026-07 the count rose',
    ]) {
      expect(maskDateShapes(text)).toHaveLength(text.length);
    }
  });

  // DUP-03
  it('fills with a character that is not whitespace', () => {
    // The whole reason the fill was changed. `readNumbers` skips whitespace
    // looking for the magnitude word attached to a figure, so a space-filled
    // date between the two let it read a magnitude across the gap.
    expect(NOISE_FILL).not.toMatch(/\s/);
    expect(NOISE_FILL).toHaveLength(1);
    expect(maskDateShapes('2026-07-27')).toBe('##########');
  });
});

describe('the union of shapes, by the author who wanted each', () => {
  // DUP-02
  it('blanks every shape both authors already masked', () => {
    expect(blanked('2026-07-27')).toBe(true);
    expect(blanked('2026/07/27')).toBe(true);
    expect(blanked('03/04/2026')).toBe(true);
    expect(blanked('8 July 2026')).toBe(true);
    expect(blanked('July 8, 2026')).toBe(true);
  });

  // DUP-02
  it('blanks the four shapes only BENCH-05 masked', () => {
    // Every one of these is a row of the brief's measured divergence table,
    // where the accuracy scorer read a figure out of a date.
    expect(blanked('03/04/26')).toBe(true);
    expect(blanked('2026-07')).toBe(true);
    expect(blanked('10:30:00')).toBe(true);
    expect(blanked('10:30')).toBe(true);
    expect(blanked('https://x.test/?rev=1150000000')).toBe(true);
    expect(blanked('July 2026')).toBe(true);
  });

  // DUP-02
  it('blanks the two shapes only BENCH-04 masked', () => {
    // Arbitrary whitespace and any case. BENCH-05 matched a single literal
    // space and lower case only, so both of these kept their figures.
    expect(blanked('JULY 8, 2026')).toBe(true);
    expect(blanked('July  8,  2026')).toBe(true);
    expect(blanked('8th\tJuly,  2026')).toBe(true);
    expect(blanked('8. Jul. 2026')).toBe(true);
  });

  // DUP-02
  it('names its shapes rather than hiding them in one regex', () => {
    // The union is the deliverable, so the count is asserted: adding a shape
    // without adding a case above should fail here first.
    expect(NOISE_SHAPE_SOURCES).toHaveLength(9);
  });
});

describe('what the mask must never blank, because both numbers are real', () => {
  // DUP-02
  it('leaves a range of years and a range of figures alone', () => {
    expect(kept('2026-2030')).toBe('2026-2030');
    expect(kept('1150-1200')).toBe('1150-1200');
    expect(kept('50-60%')).toBe('50-60%');
    // 13 is not a month, so this is a range and both numbers are real.
    expect(kept('2026-13')).toBe('2026-13');
  });

  // DUP-02
  it('leaves a ratio alone, since a clock time needs two digits after the colon', () => {
    expect(kept('a 3:1 ratio')).toBe('a 3:1 ratio');
  });
});

describe('MONTH names months rather than starting like one', () => {
  // DUP-04
  it('keeps the figure beside a word that merely begins with a month abbreviation', () => {
    // Measured against the pre-change code: `(?:jan|feb|...)[a-z]*` matched
    // `nov` + `el` and `dec` + `ade`, and BENCH-05's bare `MONTH YYYY` shape
    // then blanked the year. Carrying that shape into the shared mask without
    // this fix would have taken the same defect into the accuracy scorer.
    expect(kept('novel 2026')).toBe('novel 2026');
    expect(kept('decade 2026')).toBe('decade 2026');
    expect(kept('marginal 2026')).toBe('marginal 2026');
    expect(kept('mayonnaise 2026')).toBe('mayonnaise 2026');
    expect(kept('september-adjacent 2026')).toBe('september-adjacent 2026');
  });

  // DUP-04
  it('blanks every month name and standard abbreviation it lists, and only those', () => {
    for (const month of MONTH_NAMES) {
      expect(blanked(`${month} 2026`), month).toBe(true);
    }
    // The closure, by name. Twelve full names plus their standard
    // abbreviations, with `may` its own abbreviation and `september` carrying
    // two. Listing it is the point: a shape that blanks a bare `MONTH YYYY` is
    // only as safe as this list is closed.
    expect([...MONTH_NAMES].sort((a, b) => a.localeCompare(b))).toEqual([
      'apr',
      'april',
      'aug',
      'august',
      'dec',
      'december',
      'feb',
      'february',
      'jan',
      'january',
      'jul',
      'july',
      'jun',
      'june',
      'mar',
      'march',
      'may',
      'nov',
      'november',
      'oct',
      'october',
      'sep',
      'sept',
      'september',
    ]);
  });

  // DUP-04
  it('does not invent a month', () => {
    expect(kept('smarch 2026')).toBe('smarch 2026');
    expect(kept('undecember 2026')).toBe('undecember 2026');
  });
});

describe('a URL is consumed whole rather than mined for the dates inside it', () => {
  // DUP-02
  it('blanks a URL containing a date and a version', () => {
    expect(blanked('https://x.test/2026-07-27/v1.2.3?rev=1150000000')).toBe(true);
  });

  // DUP-02
  it('stops at the characters a report writes around a link', () => {
    expect(kept('(https://x.test/a) and 12')).toBe('(################) and 12');
  });
});
