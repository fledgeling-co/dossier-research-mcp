import { describe, expect, it } from 'vitest';
import {
  PROXIMITY_CHARS,
  containsTerm,
  findAnyTermPositions,
  findNearbyCue,
  findTermPositions,
  nearestDistance,
  normaliseForMatch,
} from './text.js';

/**
 * The matching primitives, which decide what "literally" means for the whole
 * due-weight metric.
 *
 * The two directions both matter and pull against each other. Folding too
 * little makes an honest report miss a term it did use, which is a false
 * negative that makes every backend look worse. Folding too much starts
 * crediting a synonym, which is the exact judgement the no-model rule forbids.
 */

describe('normaliseForMatch', () => {
  it('folds case', () => {
    expect(normaliseForMatch('OVERSTATED')).toBe('overstated');
  });

  it('collapses a whitespace run, including a newline, to one space', () => {
    expect(normaliseForMatch('a  \n\t b')).toBe('a b');
  });

  it('folds the typographic characters that are the same character in a costume', () => {
    expect(normaliseForMatch('don’t “quote” en–dash em—dash minus−sign')).toBe(
      'don\'t "quote" en-dash em-dash minus-sign',
    );
  });

  it('drops the invisible characters that would otherwise split a word', () => {
    // A soft hyphen sits inside a word at a line-break opportunity. Turning it
    // into a space would break the match this fold exists to keep.
    expect(normaliseForMatch('over­stated')).toBe('overstated');
    expect(normaliseForMatch('zero​width')).toBe('zerowidth');
  });

  it('survives a code point whose lower case is longer than itself', () => {
    // 'İ' lower-cases to two code units. Nothing downstream maps back to the
    // original string, which is what makes that safe rather than an off-by-one.
    expect(normaliseForMatch('İ')).toHaveLength(2);
    expect(() => normaliseForMatch('İstanbul rüya 東京 🙂')).not.toThrow();
  });

  it('is idempotent, so normalising a term twice cannot change it', () => {
    const once = normaliseForMatch('A  “Term”\nwith  spacing');
    expect(normaliseForMatch(once)).toBe(once);
  });
});

describe('findTermPositions', () => {
  const text = normaliseForMatch(
    'The claim was OVERSTATED\nby a factor of two, and they don’t agree with it.',
  );

  // DUEWT-04
  it('matches case-insensitively, across a line break, and through a curly apostrophe', () => {
    expect(findTermPositions(text, 'overstated by a factor of two')).toHaveLength(1);
    expect(findTermPositions(text, "don't")).toHaveLength(1);
    expect(findTermPositions(text, 'DON’T')).toHaveLength(1);
  });

  // DUEWT-04
  it('never matches inside a longer word', () => {
    expect(findTermPositions(text, 'over')).toHaveLength(0);
    expect(findTermPositions(normaliseForMatch('programmer'), 'gram')).toHaveLength(0);
    expect(findTermPositions(normaliseForMatch('a gram of it'), 'gram')).toHaveLength(1);
  });

  it('allows a boundary on punctuation and at either end of the text', () => {
    expect(findTermPositions(normaliseForMatch('overstated.'), 'overstated')).toHaveLength(1);
    expect(findTermPositions(normaliseForMatch('(overstated)'), 'overstated')).toHaveLength(1);
    expect(findTermPositions(normaliseForMatch('overstated'), 'overstated')).toHaveLength(1);
  });

  it('does not apply a boundary rule to an end the term does not own', () => {
    // The term ends in a bracket, so what follows it is not constrained.
    expect(findTermPositions(normaliseForMatch('see (note)x'), '(note)')).toHaveLength(1);
  });

  it('returns every occurrence, ascending', () => {
    const positions = findTermPositions(normaliseForMatch('cold fusion, then cold fusion'), 'cold fusion');
    expect(positions).toHaveLength(2);
    expect(positions[0]).toBeLessThan(positions[1] ?? -1);
  });

  it('finds an overlapping repeat rather than skipping past it', () => {
    // The scan advances one character at a time, not by the length of the term,
    // so a term that overlaps its own next occurrence is found twice.
    expect(findTermPositions(normaliseForMatch('a-a-a'), 'a-a')).toEqual([0, 2]);
  });

  it('rejects every position of a repeat that has no boundary anywhere', () => {
    // Every `aa` inside `aaaa` is flanked by a letter, so none of them is the
    // term. This is the boundary rule doing its job, not the scan missing them.
    expect(findTermPositions(normaliseForMatch('aaaa'), 'aa')).toEqual([]);
  });

  it('answers empty for an empty or whitespace-only term instead of matching everywhere', () => {
    expect(findTermPositions(normaliseForMatch('anything'), '')).toEqual([]);
    expect(findTermPositions(normaliseForMatch('anything'), '   ')).toEqual([]);
  });

  it('treats a term with a regular-expression metacharacter as literal text', () => {
    expect(findTermPositions(normaliseForMatch('a (b) c.d'), '(b)')).toHaveLength(1);
    expect(findTermPositions(normaliseForMatch('axd'), 'a.d')).toHaveLength(0);
  });

  it('containsTerm agrees with findTermPositions', () => {
    expect(containsTerm(text, 'overstated by a factor of two')).toBe(true);
    expect(containsTerm(text, 'exaggerated twofold')).toBe(false);
  });
});

describe('findAnyTermPositions', () => {
  it('merges, deduplicates and sorts across terms', () => {
    const text = normaliseForMatch('beta alpha beta');
    expect(findAnyTermPositions(text, ['beta', 'alpha', 'beta'])).toEqual([0, 5, 11]);
  });
});

describe('nearestDistance', () => {
  it('is null when either side is empty, which is not the same answer as far apart', () => {
    expect(nearestDistance([], [1])).toBeNull();
    expect(nearestDistance([1], [])).toBeNull();
    expect(nearestDistance([], [])).toBeNull();
  });

  it('finds the smallest gap across the two lists', () => {
    expect(nearestDistance([0, 100], [98, 400])).toBe(2);
    expect(nearestDistance([50], [50])).toBe(0);
  });

  it('does not depend on which list is larger or which side leads', () => {
    expect(nearestDistance([10, 20, 30], [31])).toBe(1);
    expect(nearestDistance([31], [10, 20, 30])).toBe(1);
  });
});

describe('findNearbyCue', () => {
  /** `anchor` at offset 0 and `disputed` at exactly `gap`. */
  function separated(gap: number): string {
    const prefix = 'anchor ';
    return normaliseForMatch(`${prefix}${'x'.repeat(gap - prefix.length - 1)} disputed`);
  }

  it('names the cue that fired rather than only asserting one did', () => {
    const text = normaliseForMatch('the figure is disputed by two sources');
    expect(findNearbyCue(text, findTermPositions(text, 'figure'), ['disputed', 'differ'])).toBe(
      'disputed',
    );
  });

  it('fires at the exact edge of the window and not one character past it', () => {
    const atEdge = separated(PROXIMITY_CHARS);
    expect(
      nearestDistance(findTermPositions(atEdge, 'anchor'), findTermPositions(atEdge, 'disputed')),
    ).toBe(PROXIMITY_CHARS);
    expect(findNearbyCue(atEdge, findTermPositions(atEdge, 'anchor'), ['disputed'])).toBe('disputed');

    const past = separated(PROXIMITY_CHARS + 1);
    expect(
      nearestDistance(findTermPositions(past, 'anchor'), findTermPositions(past, 'disputed')),
    ).toBe(PROXIMITY_CHARS + 1);
    expect(findNearbyCue(past, findTermPositions(past, 'anchor'), ['disputed'])).toBeNull();
  });

  it('is null when there is no anchor at all, however loudly the cue appears', () => {
    const text = normaliseForMatch('disputed, disputed, and disputed again');
    expect(findNearbyCue(text, [], ['disputed'])).toBeNull();
  });
});
