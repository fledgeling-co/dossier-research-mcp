import { describe, expect, it } from 'vitest';
import {
  canonicaliseUnit,
  DIMENSIONLESS,
  foldScaleWord,
  matchCurrencyPrefix,
  matchUnitAt,
  unitSurfaceForms,
} from './units.js';

describe('the three confusable classes stay apart (ACCREL-19)', () => {
  it('never collapses percent, percentage points and basis points', () => {
    const percent = canonicaliseUnit('percent');
    const points = canonicaliseUnit('percentage points');
    const basis = canonicaliseUnit('basis points');
    expect(new Set([percent, points, basis]).size).toBe(3);
  });

  it.each([
    ['%', 'percent'],
    ['percent', 'percent'],
    ['Percent', 'percent'],
    ['percents', 'percent'],
    ['percentage', 'percent'],
    ['per cent', 'percent'],
    ['pct', 'percent'],
    ['percentage point', 'percentage-point'],
    ['percentage points', 'percentage-point'],
    ['pp', 'percentage-point'],
    ['ppt', 'percentage-point'],
    ['p.p.', 'percentage-point'],
    ['basis points', 'basis-point'],
    ['bps', 'basis-point'],
    ['bp', 'basis-point'],
  ])('canonicalises %s to %s', (written, canonical) => {
    expect(canonicaliseUnit(written)).toBe(canonical);
  });

  it('reads the longest unit form first', () => {
    // Without longest-match, `percentage points` reads as `percentage` and the
    // sharpest of the three confusions stops being detectable.
    const hit = matchUnitAt('28.6 percentage points', 4);
    expect(hit?.surface).toBe('percentage points');
    expect(hit?.canonical).toBe('percentage-point');
  });
});

describe('currencies are one class each', () => {
  it.each([
    ['$', 'usd'],
    ['usd', 'usd'],
    ['dollars', 'usd'],
    ['us$', 'usd'],
    ['€', 'eur'],
    ['euros', 'eur'],
    ['£', 'gbp'],
    ['¥', 'jpy'],
  ])('canonicalises %s to %s', (written, canonical) => {
    expect(canonicaliseUnit(written)).toBe(canonical);
  });

  it('keeps two currencies distinct', () => {
    expect(canonicaliseUnit('USD')).not.toBe(canonicaliseUnit('EUR'));
  });

  it('finds a currency written before the number', () => {
    // Lower case throughout: both matchers document that precondition, because
    // the prose they are handed has already been through `normaliseForSearch`.
    // Passing raw text finds nothing and is indistinguishable from a report that
    // stated no unit, which would silently disable the unit rule.
    expect(matchCurrencyPrefix('$1.2b', 1)?.canonical).toBe('usd');
    expect(matchCurrencyPrefix('us$1.2b', 3)?.canonical).toBe('usd');
    expect(matchCurrencyPrefix('usd 1.2 billion', 4)?.canonical).toBe('usd');
    expect(matchCurrencyPrefix('revenue 1.2 billion', 8)).toBeNull();
  });
});

describe('an unrecognised unit is its own class, not an error', () => {
  it.each([
    ['questions', 'question'],
    ['question', 'question'],
    ['CVSS v3.1 base score', 'cvss v3.1 base score'],
    ['  Sources  ', 'source'],
  ])('canonicalises the author unit %p to %p', (written, canonical) => {
    expect(canonicaliseUnit(written)).toBe(canonical);
  });

  it('treats an empty unit and the explicit word as dimensionless', () => {
    expect(canonicaliseUnit('')).toBe(DIMENSIONLESS);
    expect(canonicaliseUnit('dimensionless')).toBe(DIMENSIONLESS);
  });

  it('does not convert between units', () => {
    // Kilometres never satisfy a gold in metres. Conversion would put arithmetic
    // inside a match test, which is not something a reader could audit.
    expect(canonicaliseUnit('km')).not.toBe(canonicaliseUnit('m'));
  });
});

describe('a gold unit may carry its own scale word (ACCREL-04)', () => {
  it.each([
    ['USD billions', 9, 'usd'],
    ['billions of USD', 9, 'usd'],
    ['millions of dollars', 6, 'usd'],
    ['thousand tonnes', 3, 'tonne'],
    ['millions', 6, DIMENSIONLESS],
  ])('folds %p into an exponent of %i over %p', (unit, exponent, canonical) => {
    const folded = foldScaleWord(unit);
    expect(folded.exponent).toBe(exponent);
    expect(folded.canonical).toBe(canonical);
  });

  it('leaves a unit with no scale word alone', () => {
    expect(foldScaleWord('USD')).toEqual({ exponent: 0, canonical: 'usd', rest: 'usd' });
    expect(foldScaleWord('percent').exponent).toBe(0);
  });

  it('does not read a bare letter in an author unit as a multiplier', () => {
    // `m` in a unit is far likelier to be metres than a million, and reading it
    // as a multiplier would move a gold value by six orders of magnitude — the
    // loudest possible way for this scorer to be wrong.
    expect(foldScaleWord('m').exponent).toBe(0);
    expect(foldScaleWord('m').canonical).toBe('metre');
    expect(foldScaleWord('t').exponent).toBe(0);
  });
});

describe('surface forms', () => {
  it('include the lexicon forms for the class', () => {
    const forms = unitSurfaceForms('percent', 'percent');
    expect(forms).toContain('%');
    expect(forms).toContain('per cent');
  });

  it('include the author own wording and its plural', () => {
    const forms = unitSurfaceForms('question', 'questions');
    expect(forms).toContain('questions');
    expect(forms).toContain('question');
  });

  it('are empty of blanks for a dimensionless unit', () => {
    expect(unitSurfaceForms(DIMENSIONLESS, 'dimensionless')).toEqual([]);
  });
});

describe('matchUnitAt respects word boundaries', () => {
  it('does not match a unit letter inside a longer word', () => {
    expect(matchUnitAt('450 market share', 3)).toBeNull();
  });

  it('matches a symbol with no boundary at all', () => {
    expect(matchUnitAt('28.6%', 4)?.canonical).toBe('percent');
  });

  it('allows one space before the unit', () => {
    expect(matchUnitAt('28.6 %', 4)?.canonical).toBe('percent');
    expect(matchUnitAt('450 km', 3)?.canonical).toBe('kilometre');
  });

  it('accepts an extra form the caller supplies', () => {
    expect(matchUnitAt('303 questions', 3)).toBeNull();
    expect(matchUnitAt('303 questions', 3, ['questions'])?.canonical).toBe('question');
  });
});
