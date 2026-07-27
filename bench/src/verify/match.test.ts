import { describe, expect, it } from 'vitest';
import {
  dateForms,
  decodeEntities,
  extractText,
  normalise,
  numberForms,
  quoteAppears,
  valueAppears,
} from './match.js';

/**
 * The matching rules decide whether a gold fact is provable, and a wrong answer
 * here is the most expensive kind this item can produce: a false `absent`
 * accuses the author of fabricating a fact that is really there, and a false
 * `present` admits a corpus that was never checked. Both directions are tested.
 */

describe('decodeEntities', () => {
  it('decodes named, decimal and hex references', () => {
    expect(decodeEntities('a &amp; b &#39;c&#39; &#x2014; d')).toBe("a & b 'c' — d");
  });

  it('leaves an unknown entity as written rather than guessing', () => {
    expect(decodeEntities('&notarealentity; &amp;')).toBe('&notarealentity; &');
  });

  it('refuses an out-of-range or surrogate code point instead of throwing', () => {
    expect(decodeEntities('&#xD800; &#999999999;')).toBe('&#xD800; &#999999999;');
  });
});

describe('extractText', () => {
  it('passes JSON through, because the API response is the readable form', () => {
    const body = '{"baseScore":8.8,"baseSeverity":"HIGH"}';
    expect(extractText(body)).toContain('"baseScore":8.8');
  });

  it('unescapes the JSON solidus so a DOI matches its printed form', () => {
    // Crossref really returns this. Without the rule, every DOI reads absent.
    const body = '{"DOI":"10.1038\\/s41586-026-10726-x"}';
    expect(extractText(body)).toContain('10.1038/s41586-026-10726-x');
  });

  it('drops script and style bodies before stripping tags', () => {
    const html = '<p>Score 7.5</p><script>var wrong = 9.9;</script><style>a{top:3.3px}</style>';
    const text = extractText(html, 'text/html');
    expect(text).toContain('Score 7.5');
    expect(text).not.toContain('9.9');
    expect(text).not.toContain('3.3');
  });

  it('decodes entities left behind by tag stripping', () => {
    expect(extractText('<p>Smith &amp; Co</p>', 'text/html')).toContain('Smith & Co');
  });
});

describe('normalise', () => {
  it('collapses whitespace and folds case', () => {
    expect(normalise('  A  \n B ')).toBe('a b');
  });

  it('folds typographic quotes and dashes onto their plain forms', () => {
    expect(normalise('“quoted” — it’s')).toBe('"quoted" - it\'s');
  });
});

describe('quoteAppears', () => {
  it('finds a quote across a line break in the source', () => {
    expect(quoteAppears('total revenue for\nthe year was $1.2 billion', 'revenue for the year')).toBe(
      'present',
    );
  });

  it('reports a quote that is genuinely not there', () => {
    expect(quoteAppears('nothing like it here', 'revenue for the year')).toBe('absent');
  });
});

describe('numberForms', () => {
  it('offers thousands separators for an integer', () => {
    expect(numberForms(1_500_000)).toEqual(expect.arrayContaining(['1500000', '1,500,000']));
  });

  it('offers the one-decimal spelling of a whole score', () => {
    expect(numberForms(8)).toEqual(expect.arrayContaining(['8', '8.0']));
  });

  it('does not offer a padded form that would also accept a different number', () => {
    // 8.80 round-trips, so it is offered; 8.804 does not equal 8.8 and must not
    // be reachable through any offered form.
    expect(numberForms(8.8)).toContain('8.8');
    expect(numberForms(8.8)).not.toContain('8.804');
  });

  it('never emits exponent notation, which appears in no publisher page', () => {
    expect(numberForms(1e21).some((f) => f.includes('e+'))).toBe(false);
  });
});

describe('dateForms', () => {
  it('offers ISO and the long forms a release note would use', () => {
    expect(dateForms('2026-07-08')).toEqual(
      expect.arrayContaining(['2026-07-08', '8 July 2026', 'July 8, 2026']),
    );
  });

  it('returns the input unchanged when it is not a calendar date', () => {
    expect(dateForms('not-a-date')).toEqual(['not-a-date']);
  });
});

describe('valueAppears', () => {
  it('matches any one spelling, because the forms are alternatives', () => {
    expect(valueAppears('published 8 July 2026', { forms: dateForms('2026-07-08') })).toBe('present');
  });

  it('reports absent when no spelling occurs', () => {
    expect(valueAppears('published 9 July 2026', { forms: dateForms('2026-07-08') })).toBe('absent');
  });

  it('matches a number written with separators', () => {
    expect(valueAppears('a total of 1,500,000 rows', { forms: numberForms(1_500_000) })).toBe(
      'present',
    );
  });
});
