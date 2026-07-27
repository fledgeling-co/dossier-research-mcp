import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIDENCE_PROBABILITY,
  findAllMentions,
  findConfidenceMarkers,
  findMention,
  mentions,
  paragraphAt,
  paragraphRanges,
} from './confidence.js';

/**
 * The marker parser, asserted one form at a time.
 *
 * Every fixture here is written in a shape `src/research/prompt.ts` actually
 * asks a backend to produce, so a passing test is evidence about reports this
 * product will really receive rather than about a format invented for the test.
 */

describe('CALIB-01 the four marker forms', () => {
  it('reads the executive-summary bullet leader, bolded and unbolded', () => {
    const markers = findConfidenceMarkers(
      '- **(High Confidence)** The filing states 1.2 billion.\n- (Low confidence) The follow-on is unclear.',
    );
    expect(markers.map((m) => m.level)).toEqual(['high', 'low']);
    expect(markers.map((m) => m.form)).toEqual(['parenthesised', 'parenthesised']);
  });

  it('reads the epistemic-bounding tag at every level', () => {
    const markers = findConfidenceMarkers(
      '<CONFIDENCE:LOW>The 2027 figure is an estimate.</CONFIDENCE:LOW> and <CONFIDENCE:MEDIUM>the 2026 one is not.</CONFIDENCE:MEDIUM>',
    );
    expect(markers.map((m) => m.level)).toEqual(['low', 'medium']);
    expect(markers[0]?.span).toBe('The 2027 figure is an estimate.');
  });

  it('reads the labelled form, and treats N/A as an abstention rather than a low', () => {
    const markers = findConfidenceMarkers(
      '**Sources found: 0.** **Confidence: N/A**, for want of evidence.\n\nConfidence: Medium on the rest.',
    );
    expect(markers.map((m) => m.level)).toEqual([null, 'medium']);
    expect(markers.map((m) => m.form)).toEqual(['labelled', 'labelled']);
  });

  it('reads the trailing-label form', () => {
    const markers = findConfidenceMarkers('Medium Confidence: the vendor has not published a figure.');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.level).toBe('medium');
    expect(markers[0]?.form).toBe('trailing-label');
  });

  it('does not invent a marker out of ordinary prose about confidence', () => {
    expect(
      findConfidenceMarkers(
        'The study reports a 95% confidence interval, and the authors express high confidence in the method.',
      ),
    ).toEqual([]);
  });

  it('counts one marker where two patterns overlap on the same words', () => {
    const markers = findConfidenceMarkers('**(High Confidence)**: the number is 12.');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.form).toBe('parenthesised');
  });
});

describe('CALIB-02 what a marker governs', () => {
  it('gives a tag exactly its own contents and nothing after the close', () => {
    const markers = findConfidenceMarkers(
      '<CONFIDENCE:LOW>inside the tag</CONFIDENCE:LOW> outside the tag',
    );
    expect(markers[0]?.span).toBe('inside the tag');
    expect(markers[0]?.span).not.toContain('outside');
  });

  it('stops an undelimited span at the next marker', () => {
    const markers = findConfidenceMarkers(
      '(High Confidence) revenue was 1.2 billion. (Low Confidence) headcount is unclear.',
    );
    expect(markers[0]?.span).toContain('revenue');
    expect(markers[0]?.span).not.toContain('headcount');
    expect(markers[1]?.span).toContain('headcount');
  });

  it('stops an undelimited span at the paragraph break when no marker follows', () => {
    const markers = findConfidenceMarkers(
      '(High Confidence) revenue was 1.2 billion.\n\nA later paragraph mentions headcount.',
    );
    expect(markers[0]?.span).toContain('revenue');
    expect(markers[0]?.span).not.toContain('headcount');
  });

  it('keeps a bullet list one marker per line', () => {
    const markers = findConfidenceMarkers(
      ['- (High Confidence) Alpha shipped.', '- (Low Confidence) Beta may ship.'].join('\n'),
    );
    expect(markers[0]?.span).toContain('Alpha');
    expect(markers[0]?.span).not.toContain('Beta');
  });
});

describe('CALIB-03 subject matching', () => {
  it('matches on word boundaries and not inside a longer word', () => {
    expect(mentions('the AI market', 'AI')).toBe(true);
    expect(mentions('he said nothing', 'AI')).toBe(false);
  });

  it('is case-insensitive and Unicode-normalised', () => {
    expect(mentions('Meta Platforms, Inc.', 'meta platforms')).toBe(true);
    expect(mentions('the ﬁling', 'filing')).toBe(true);
  });

  it('does not demand a boundary on a side where the term is punctuation', () => {
    expect(mentions('it cost $1.2bn last year', '$1.2bn')).toBe(true);
  });

  it('returns -1 for an empty or whitespace-only term rather than matching everything', () => {
    expect(findMention('anything at all', '   ')).toBe(-1);
    expect(mentions('anything at all', '')).toBe(false);
  });

  it('finds every occurrence, with the left boundary still checked after the first', () => {
    // `xalpha` must not match: without a shared coordinate system the second
    // search would slice away the `x` and read the match as boundary-clean.
    expect(findAllMentions('alpha and xalpha and alpha', 'alpha')).toEqual([0, 21]);
  });
});

describe('paragraph ranges', () => {
  it('splits on blank lines and covers the whole text', () => {
    const text = 'one\n\ntwo\n\nthree';
    const ranges = paragraphRanges(text);
    expect(ranges).toHaveLength(3);
    expect(text.slice(ranges[0]?.start, ranges[0]?.end)).toBe('one');
    expect(text.slice(ranges[2]?.start, ranges[2]?.end)).toBe('three');
  });

  it('returns one range for a text with no blank line', () => {
    expect(paragraphRanges('single block\nwith a soft break')).toHaveLength(1);
  });

  it('locates an index in its own paragraph', () => {
    const text = 'one\n\ntwo';
    const ranges = paragraphRanges(text);
    expect(paragraphAt(ranges, 0).start).toBe(0);
    expect(paragraphAt(ranges, 6).start).toBe(5);
  });
});

describe('the probability map', () => {
  it('is ordered and strictly between zero and one', () => {
    const { high, medium, low } = DEFAULT_CONFIDENCE_PROBABILITY;
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });
});
