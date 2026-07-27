import { describe, expect, it } from 'vitest';
import { anchorHonesty, checkableTokens, containment, type SourceEvidence } from './containment.js';

/**
 * Token containment, and the three ways it declines to answer.
 *
 * The `unchecked` cases carry most of the weight here. Containment is
 * deliberately weaker than a reader, and the only way a weak check stays honest
 * is by refusing to convert "I could not look" into "it is not there". Each of
 * the three has its own test, because each is a different way a page fails to
 * be evidence.
 */

function page(over: Partial<SourceEvidence> = {}): SourceEvidence {
  return {
    url: 'https://example.com/a',
    text: '',
    truncated: false,
    verdict: 'live',
    completeHtml: true,
    anchors: [],
    ...over,
  };
}

describe('token extraction', () => {
  it('keeps a percentage whole rather than leaving a loose number behind', () => {
    const tokens = checkableTokens('Adoption reached 28.6% last year.');
    const percentages = tokens.filter((t) => t.cls === 'percentage');
    expect(percentages).toHaveLength(1);
    expect(tokens.filter((t) => t.cls === 'number' && t.text === '28.6')).toEqual([]);
  });

  it('reads a scale word as part of the figure', () => {
    const [token] = checkableTokens('Revenue was 1.2 billion.').filter((t) => t.cls === 'number');
    expect(token?.text).toBe('1.2 billion');
    expect(token?.forms).toContain('1200000000');
  });

  it('reads a year as a year', () => {
    expect(checkableTokens('Published in 2019.').some((t) => t.cls === 'year')).toBe(true);
  });

  it('joins a run of proper nouns into one token', () => {
    const nouns = checkableTokens('The filing named Meta Platforms as the buyer.').filter(
      (t) => t.cls === 'proper-noun',
    );
    expect(nouns.map((n) => n.text)).toContain('Meta Platforms');
  });

  it('does not read a sentence-initial capital or a connective as a proper noun', () => {
    const nouns = checkableTokens('However the figure held.').filter((t) => t.cls === 'proper-noun');
    expect(nouns).toEqual([]);
  });

  it('reads an identifier inside a statement', () => {
    expect(
      checkableTokens('Reported at 10.1038/nature12373.').some((t) => t.cls === 'identifier'),
    ).toBe(true);
  });
});

describe('generosity about form (CITE-21, CITE-42)', () => {
  it('matches a percentage written as words', () => {
    const result = containment('Share reached 28.6%.', page({ text: 'It reached 28.6 percent.' }));
    expect(result.verdict).toBe('supported');
  });

  it('matches a thousands separator against a plain integer, through the shared primitives', () => {
    const result = containment('Total was 1,200 units.', page({ text: 'a total of 1200 units' }));
    expect(result.verdict).toBe('supported');
  });

  it('matches a scaled figure written out in full', () => {
    const result = containment(
      'Revenue was 1.2 billion.',
      page({ text: 'revenue of 1,200,000,000 for the year' }),
    );
    expect(result.verdict).toBe('supported');
  });
});

describe('the verdict rule (CITE-18, CITE-19, CITE-20)', () => {
  it('is supported only when every checkable token appears', () => {
    const supported = containment(
      'Adoption reached 28.6% in 2024.',
      page({ text: 'By 2024 adoption had reached 28.6%.' }),
    );
    expect(supported.verdict).toBe('supported');

    const missing = containment(
      'Adoption reached 28.6% in 2024.',
      page({ text: 'By 2024 adoption had reached 31.2%.' }),
    );
    expect(missing.verdict).toBe('unsupported');
    expect(missing.missing).toContain('28.6%');
  });

  it('is unchecked when the statement carries nothing checkable', () => {
    const result = containment('it did not.', page({ text: 'anything at all' }));
    expect(result.verdict).toBe('unchecked');
    expect(result.why).toMatch(/no number, year, identifier or name/);
  });

  it('is unchecked when the page was never fetched', () => {
    expect(containment('Adoption reached 28.6%.', undefined).verdict).toBe('unchecked');
  });

  it('is unchecked when the page did not resolve', () => {
    const result = containment('Adoption reached 28.6%.', page({ verdict: 'not_found', text: '' }));
    expect(result.verdict).toBe('unchecked');
    expect(result.why).toMatch(/did not resolve/);
  });

  it('is unchecked, never unsupported, when the body was cut short', () => {
    const result = containment(
      'Adoption reached 28.6%.',
      page({ text: 'the opening of a very long page', truncated: true }),
    );
    expect(result.verdict).toBe('unchecked');
    expect(result.why).toMatch(/cut short/);
  });

  it('is still supported on a truncated page when the token was found before the cut', () => {
    const result = containment(
      'Adoption reached 28.6%.',
      page({ text: 'adoption reached 28.6% and then', truncated: true }),
    );
    expect(result.verdict).toBe('supported');
  });

  it('says what it is, and does not claim to be claim verification', () => {
    const result = containment('Adoption reached 28.6%.', page({ text: 'reached 28.6%' }));
    expect(result.why).toMatch(/containment, not entailment/);
  });
});

describe('anchor honesty (CITE-23, CITE-24)', () => {
  it('is honest when the page declares the anchor', () => {
    const result = anchorHonesty('https://example.com/a#results', page({ anchors: ['results'] }));
    expect(result.verdict).toBe('honest');
  });

  it('is missing when it does not', () => {
    const result = anchorHonesty('https://example.com/a#results', page({ anchors: ['intro'] }));
    expect(result.verdict).toBe('missing');
  });

  it('decodes a percent-encoded fragment before comparing', () => {
    const result = anchorHonesty('https://example.com/a#a%20b', page({ anchors: ['a b'] }));
    expect(result.verdict).toBe('honest');
  });

  it('is not applicable with no fragment', () => {
    expect(anchorHonesty('https://example.com/a', page()).verdict).toBe('not-applicable');
  });

  it('is not applicable for a text fragment', () => {
    const result = anchorHonesty('https://example.com/a#:~:text=hello', page({ anchors: [] }));
    expect(result.verdict).toBe('not-applicable');
  });

  it('is not applicable for a PDF page fragment', () => {
    expect(anchorHonesty('https://example.com/a.pdf#page=4', page()).verdict).toBe('not-applicable');
    expect(anchorHonesty('https://example.com/a.pdf#12', page()).verdict).toBe('not-applicable');
  });

  it('is unchecked, never missing, when the body was not complete readable HTML', () => {
    const result = anchorHonesty('https://example.com/a#results', page({ completeHtml: false }));
    expect(result.verdict).toBe('unchecked');
  });

  it('is unchecked when the page did not resolve', () => {
    const result = anchorHonesty('https://example.com/a#results', page({ verdict: 'blocked' }));
    expect(result.verdict).toBe('unchecked');
  });

  it('is unchecked when there is no page at all', () => {
    expect(anchorHonesty('https://example.com/a#results', undefined).verdict).toBe('unchecked');
  });
});
