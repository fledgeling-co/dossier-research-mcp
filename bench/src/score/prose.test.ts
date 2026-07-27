import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractCitedUrls } from '../../../src/research/report.js';
import { normaliseForSearch } from './confidence.js';
import { extractProse, isNegated, NEGATION_CUES, NEGATION_WINDOW_WORDS } from './prose.js';

const negatedIn = (sentence: string, needle: string): boolean => {
  const hay = normaliseForSearch(sentence);
  const i = hay.indexOf(normaliseForSearch(needle));
  expect(i).toBeGreaterThanOrEqual(0);
  return isNegated(hay, i);
};

describe('extractProse strips every citation form (ACCREL-06)', () => {
  it.each([
    ['a markdown link target', 'Revenue grew ([source](https://x.test/revenue-1200000000)).'],
    ['an image target', 'Revenue grew ![chart](https://x.test/revenue-1200000000).'],
    ['a CommonMark autolink', 'Revenue grew <https://x.test/revenue-1200000000>.'],
    ['a bare URL', 'Revenue grew, see https://x.test/revenue-1200000000 for detail.'],
    ['a reference definition', 'Revenue grew [1].\n\n[1]: https://x.test/revenue-1200000000'],
    ['a cite tag', 'Revenue grew <cite url="https://x.test/revenue-1200000000">as reported</cite>.'],
  ])('removes the figure carried only by %s', (_name, markdown) => {
    expect(markdown).toContain('1200000000');
    expect(extractProse(markdown)).not.toContain('1200000000');
  });

  it('covers every form the citation extractor itself recognises', () => {
    // Kept in step with `src/research/report.ts` by construction rather than by
    // memory: if a sixth form is added there, this fails until it is handled
    // here too. A figure surviving in a form nobody stripped is the exact defect
    // this module exists to prevent.
    const sample = [
      'Inline <cite url="https://a.test/one">tagged</cite> text.',
      'A [link](https://b.test/two) and an ![image](https://c.test/three).',
      'An autolink <https://d.test/four>.',
      'A bare https://e.test/five in prose.',
      '',
      '[ref]: https://f.test/six',
    ].join('\n');

    expect(extractCitedUrls(sample)).toHaveLength(6);
    const prose = extractProse(sample);
    for (const url of extractCitedUrls(sample)) {
      expect(prose).not.toContain(url);
    }
  });

  it('keeps the prose around a stripped citation', () => {
    const prose = extractProse('Revenue reached $1.2 billion [source](https://x.test/a) last year.');
    expect(prose).toContain('$1.2 billion');
    expect(prose).toContain('last year');
  });

  it('never fuses two words across a stripped citation', () => {
    const prose = extractProse('alpha<https://x.test/a>beta');
    expect(prose).not.toContain('alphabeta');
  });

  it('strips a link target that contains a closing parenthesis', () => {
    // Wikipedia-style URLs really do carry one, and the inline-link pattern
    // stops at the first `)`. What matters is that no digit escapes; a stray
    // bracket left in the prose cannot be mistaken for a figure.
    const md = 'See [wiki](https://en.wikipedia.org/wiki/Foo_(1200000000)) here.';
    const prose = extractProse(md);
    expect(prose).not.toContain('1200000000');
    expect(prose).not.toContain('wikipedia');
  });
});

describe('link text (ACCREL-07)', () => {
  it('drops link text that is a bare hostname, which is this repo own citation style', () => {
    const prose = extractProse('As reported [arxiv.org](https://arxiv.org/abs/2509.04499).');
    expect(prose).not.toContain('arxiv.org');
    expect(prose).toContain('As reported');
  });

  it('drops link text that is itself a URL', () => {
    const prose = extractProse('See [https://x.test/a](https://x.test/a).');
    expect(prose).not.toContain('x.test');
  });

  it('keeps link text that is prose', () => {
    const prose = extractProse('As [Reuters reported](https://reuters.test/a) last week.');
    expect(prose).toContain('Reuters reported');
    expect(prose).not.toContain('reuters.test');
  });

  it('keeps link text that merely contains a dot', () => {
    const prose = extractProse('The figure was [1.2 billion](https://x.test/a).');
    expect(prose).toContain('1.2 billion');
  });
});

describe('negation (ACCREL-08)', () => {
  it.each([
    'Revenue was not 1.2 billion.',
    "Revenue wasn't 1.2 billion.",
    'Revenue never reached 1.2 billion.',
    'The figure cannot be 1.2 billion.',
    'The report gives 900 million rather than 1.2 billion.',
    'There is no evidence for 1.2 billion.',
    'It was reported incorrectly as 1.2 billion.',
  ])('reads a denial in %p', (sentence) => {
    expect(negatedIn(sentence, '1.2 billion')).toBe(true);
  });

  it.each([
    'Revenue reached 1.2 billion.',
    'Revenue was confirmed at 1.2 billion.',
    'It is not 900 million, but 1.2 billion.',
    'It is not 900 million; 1.2 billion is the figure.',
    'Revenue was not disclosed until March. It reached 1.2 billion.',
  ])('leaves %p positive', (sentence) => {
    expect(negatedIn(sentence, '1.2 billion')).toBe(false);
  });

  it('does not let a decimal point cut its own clause', () => {
    // `1.2` contains a `.`; treating it as a clause break would hide the cue.
    expect(negatedIn('The revenue was not 1.2 billion.', '1.2 billion')).toBe(true);
  });

  it('stops a cue reaching past its window', () => {
    const far = `It is not the case that we can say very much at all about any of this here today, 1.2 billion.`;
    expect(negatedIn(far, '1.2 billion')).toBe(false);
    expect(NEGATION_WINDOW_WORDS).toBe(10);
  });

  it('does not read a bare "no" as a denial', () => {
    // "no fewer than 303" asserts 303. A cue list that caught it would invent a
    // false negative in the category where false negatives are most expensive.
    expect(NEGATION_CUES).not.toContain('no');
    expect(negatedIn('There were no fewer than 303 questions.', '303')).toBe(false);
  });

  it('is a documented cue list rather than comprehension', () => {
    // Recorded as a known limit, not hidden: a denial phrased without a cue is
    // invisible here, and the scorer says so in its notes.
    expect(negatedIn('The claim that revenue reached 1.2 billion is disputed.', '1.2 billion')).toBe(
      false,
    );
  });

  it('needs no cue at all when the clause is empty before the match', () => {
    expect(negatedIn('1.2 billion was the figure.', '1.2 billion')).toBe(false);
  });
});

describe('this module never reads a file or a network', () => {
  it('imports nothing from node:fs or node:http in its own source', () => {
    // The same guarantee the pure corpus loader asserts about itself, for the
    // same reason: a scorer must be testable without a filesystem, and the only
    // way that stays true is a check that fails when somebody adds an import.
    const source = readFileSync(new URL('prose.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"]node:(fs|http|https|net)/);
  });
});
