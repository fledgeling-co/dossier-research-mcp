import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIDENCE_PROBABILITY,
  findAllMentions,
  findConfidenceMarkers,
  findMention,
  mentions,
  normaliseForSearch,
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

describe('CALIB-15 a qualifier written after its claim', () => {
  it('governs the claim before it rather than an empty span', () => {
    for (const report of [
      'Revenue reached 1.2 billion in FY2024. (High Confidence)',
      'Revenue reached 1.2 billion in FY2024. **Confidence: High**',
      'Revenue reached 1.2 billion in FY2024 (high confidence).',
    ]) {
      const markers = findConfidenceMarkers(report);
      expect(markers).toHaveLength(1);
      expect(markers[0]?.level).toBe('high');
      expect(markers[0]?.direction).toBe('backward');
      expect(markers[0]?.span).toContain('Revenue reached 1.2 billion');
    }
  });

  it('reads back only to the start of its own paragraph', () => {
    const markers = findConfidenceMarkers(
      'An earlier paragraph about headcount.\n\nRevenue reached 1.2 billion. (Low Confidence)',
    );
    expect(markers[0]?.span).toContain('Revenue');
    expect(markers[0]?.span).not.toContain('headcount');
  });

  it('does not claim text a preceding marker already governs', () => {
    const markers = findConfidenceMarkers('(High Confidence) Alpha shipped. (Low Confidence)');
    expect(markers[0]?.span).toContain('Alpha');
    expect(markers[1]?.span.trim()).toBe('');
  });
});

describe('CALIB-16 the trailing-label form is a line leader', () => {
  it('is not read out of ordinary prose that happens to carry a colon', () => {
    expect(
      findConfidenceMarkers(
        'The authors express high confidence: the method is sound and the sample is large.',
      ),
    ).toEqual([]);
  });

  it('is still read at the head of a line and behind a bullet', () => {
    const markers = findConfidenceMarkers(
      'Preamble.\n- **Medium Confidence:** the vendor has not published a figure.',
    );
    expect(markers.map((m) => m.level)).toEqual(['medium']);
    expect(markers[0]?.form).toBe('trailing-label');
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

describe('CONF-U1 the boundary is read in code points, not code units', () => {
  /**
   * A supplementary-plane letter that survives NFKC.
   *
   * The mathematical alphanumerics would be the commoner case in a pasted report
   * and NFKC folds them to ASCII before this check runs, so they cannot show the
   * defect. Deseret does not fold, and neither do the CJK extensions, Gothic,
   * Osage or Adlam that a report citing non-Latin sources carries.
   */
  const SUPP = '\u{10400}';

  it('refuses a term wedged between two supplementary-plane letters', () => {
    // Indexing by code unit returns a lone surrogate on each side, which
    // `\p{L}` does not match, so the boundary rule read "letter" as "not a
    // letter" and this answered true.
    expect(mentions(`a${SUPP}AI${SUPP}b`, 'AI')).toBe(false);
    expect(findMention(`a${SUPP}AI${SUPP}b`, 'AI')).toBe(-1);
  });

  it('refuses it on each side alone, since both sides carried the defect', () => {
    expect(mentions(`${SUPP}AI`, 'AI')).toBe(false);
    expect(mentions(`AI${SUPP}`, 'AI')).toBe(false);
  });

  it('agrees with the plain-BMP control it is supposed to behave like', () => {
    expect(mentions('saidAIsaid', 'AI')).toBe(false);
    expect(mentions('the AI market', 'AI')).toBe(true);
  });

  it('still matches beside a supplementary-plane NON-letter', () => {
    // An emoji is not a word character, so it is a boundary rather than a
    // neighbour. Over-correcting to "any surrogate blocks a match" would break
    // this, and it is the ordinary case in report prose.
    expect(mentions('\u{1F600}AI\u{1F600}', 'AI')).toBe(true);
  });

  it('reads the needle’s own ends as code points too', () => {
    // A needle that begins or ends with a supplementary-plane letter has to
    // demand a boundary there; reading its first code unit says it does not.
    expect(mentions(`x${SUPP}zephyr`, `${SUPP}zephyr`)).toBe(false);
    expect(mentions(`say ${SUPP}zephyr now`, `${SUPP}zephyr`)).toBe(true);
  });
});

describe('CALIB-17 a label that lands on a line break', () => {
  it('still matches, because markdown wraps prose and a label does not', () => {
    expect(mentions('reported by Meta\nPlatforms, Inc. in the filing', 'Meta Platforms, Inc.')).toBe(
      true,
    );
    expect(mentions('reported by Meta  Platforms in the filing', 'Meta Platforms')).toBe(true);
  });

  it('returns an index in the coordinates of the haystack it was given', () => {
    const haystack = 'xx reported by Meta\nPlatforms in the filing';
    expect(findMention(haystack, 'Meta Platforms')).toBe(haystack.indexOf('Meta'));
  });
});

describe('CALIB-18 normalising for search', () => {
  it('is idempotent, so an index taken twice cannot shift', () => {
    // NFKC then lower-case is not a fixed point on its own: an uppercase J with
    // a combining caron has no precomposed form, so the fold lets a second pass
    // compose it and every later index moves.
    for (const sample of ['J̌', 'T̈', 'Áͅ', 'ordinary text', 'ﬁling']) {
      const once = normaliseForSearch(sample);
      expect(normaliseForSearch(once)).toBe(once);
    }
  });

  it('keeps paragraph attribution stable when a caller normalises first', () => {
    const raw = `There is no evidence for the premise. ${'J̌'.repeat(60)}\n\nZephyr is discussed here.`;
    const normalised = normaliseForSearch(raw);
    const ranges = paragraphRanges(normalised);
    const at = findAllMentions(normalised, 'Zephyr')[0] ?? -1;
    expect(at).toBeGreaterThan(-1);
    // The second paragraph, not dragged back across the break by a shifted index.
    expect(paragraphAt(ranges, at).start).toBe(ranges[1]?.start);
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

  it('attributes an index inside the separator to the paragraph before it', () => {
    // It used to answer `{ start: 0, end: 0 }`, which collides with the genuine
    // first paragraph wherever a caller keys on `start`.
    const ranges = paragraphRanges('one\n\ntwo');
    expect(paragraphAt(ranges, 4)).toEqual({ start: 0, end: 3 });
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
