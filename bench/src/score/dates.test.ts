import { describe, expect, it } from 'vitest';
import { normaliseForSearch } from './confidence.js';
import { goldDay, readDates } from './dates.js';

const days = (text: string): number[] =>
  readDates(normaliseForSearch(text)).flatMap((m) => m.days);

const hits = (text: string, iso: string): boolean => days(text).includes(goldDay(iso));

describe('every accepted written form (ACCREL-11)', () => {
  it.each([
    '2026-07-08',
    '2026/07/08',
    '8 July 2026',
    '08 July 2026',
    '8 Jul 2026',
    '8th July 2026',
    'July 8, 2026',
    'July 8 2026',
    'Jul 8, 2026',
    'July 8th, 2026',
  ])('reads %p as the eighth of July', (written) => {
    expect(hits(`published ${written} in full`, '2026-07-08')).toBe(true);
  });

  it('compares as a whole UTC day, so a time zone cannot move it', () => {
    // Both sides go through the task format's own day arithmetic rather than a
    // second definition of what a day is.
    expect(goldDay('2026-07-08')).toBe(goldDay('2026-07-08'));
    expect(goldDay('2026-07-09') - goldDay('2026-07-08')).toBe(1);
  });
});

describe('what is deliberately not a match (ACCREL-11)', () => {
  it('does not accept a month and year with no day', () => {
    // "July 2026" has not stated the eighth. Crediting it would let a report
    // that named the month score the same as one that found the day.
    expect(hits('published in July 2026', '2026-07-08')).toBe(false);
  });

  it('refuses an impossible calendar day', () => {
    expect(days('2026-02-30')).toHaveLength(0);
    expect(days('2026-13-01')).toHaveLength(0);
    expect(days('30 February 2026')).toHaveLength(0);
  });

  it('accepts a leap day only in a leap year', () => {
    expect(hits('29 February 2024', '2024-02-29')).toBe(true);
    expect(days('29 February 2026')).toHaveLength(0);
  });

  it('does not read a bare year as a date', () => {
    expect(days('in 2026 the figure rose')).toHaveLength(0);
  });
});

describe('an ambiguous numeric date is read both ways (ACCREL-11)', () => {
  it('matches either reading and says the form is ambiguous', () => {
    const mentions = readDates(normaliseForSearch('dated 03/04/2026'));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.ambiguous).toBe(true);
    expect(mentions[0]?.days).toHaveLength(2);
    expect(hits('dated 03/04/2026', '2026-04-03')).toBe(true);
    expect(hits('dated 03/04/2026', '2026-03-04')).toBe(true);
  });

  it('is unambiguous when one component cannot be a month', () => {
    const mentions = readDates(normaliseForSearch('dated 22/07/2026'));
    expect(mentions[0]?.ambiguous).toBe(false);
    expect(hits('dated 22/07/2026', '2026-07-22')).toBe(true);
  });

  it('never re-reads an ISO date as an ambiguous numeric one', () => {
    const mentions = readDates(normaliseForSearch('2026-07-08'));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.form).toBe('iso');
    expect(mentions[0]?.ambiguous).toBe(false);
  });
});

describe('several dates in one report', () => {
  it('reads each one, in document order', () => {
    const mentions = readDates(
      normaliseForSearch('first 2026-07-01, then 8 July 2026, then July 15, 2026'),
    );
    expect(mentions).toHaveLength(3);
    expect(mentions.map((m) => m.start)).toEqual([...mentions.map((m) => m.start)].sort((a, b) => a - b));
    expect(mentions[0]?.form).toBe('iso');
    expect(mentions[1]?.form).toBe('day-month-year');
    expect(mentions[2]?.form).toBe('month-day-year');
  });
});
