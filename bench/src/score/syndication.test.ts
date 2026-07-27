import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  containment,
  hashShingle,
  MAX_PAGE_CHARS,
  MIN_SHINGLES,
  normaliseForShingling,
  resemblance,
  sameStory,
  shingleHashes,
  SHINGLE_WORDS,
  SYNDICATION_CONTAINMENT,
  SYNDICATION_RESEMBLANCE,
} from './syndication.js';
import { INDEPENDENT_ARTICLES, WIRE_PRINTINGS, WIRE_TRUNCATED } from './wire-fixtures.js';

/**
 * A shingle set of an exact size, built from numbers rather than prose.
 *
 * The threshold tests need pairs whose resemblance is a chosen value to three
 * decimal places, which no amount of careful writing gives you. Constructing the
 * sets directly is the only way to assert what happens immediately below, at,
 * and immediately above a bar, which is the check that catches a `>` written
 * where a `>=` belonged.
 */
const setOf = (from: number, count: number): Set<number> =>
  new Set(Array.from({ length: count }, (_, i) => from + i));

describe('SRCQ-11 the judgement calls are exported constants, not literals in a branch', () => {
  it('exports every threshold and cap as a value a test can assert', () => {
    expect(SHINGLE_WORDS).toBe(10);
    expect(SYNDICATION_RESEMBLANCE).toBe(0.7);
    expect(SYNDICATION_CONTAINMENT).toBe(0.9);
    expect(MIN_SHINGLES).toBe(100);
    expect(MAX_PAGE_CHARS).toBe(200_000);
  });
});

describe('SRCQ-17 normalisation', () => {
  it('lowercases, drops punctuation and keeps digits', () => {
    expect(normaliseForShingling('The Rate: 3.85 per cent!')).toEqual([
      'the', 'rate', '3', '85', 'per', 'cent',
    ]);
  });

  it('returns nothing for text with no letters or digits at all', () => {
    expect(normaliseForShingling('   --- ... ')).toEqual([]);
    expect(normaliseForShingling('')).toEqual([]);
  });

  it('is unmoved by case, punctuation style and reflowed whitespace', () => {
    const plain = 'the board left the cash rate unchanged at three point eight five per cent today';
    const typeset = '  The board — left the "cash rate" unchanged,\n\n  at three point eight five per cent today.  ';
    expect(shingleHashes(typeset)).toEqual(shingleHashes(plain));
  });

  it('yields no shingles at all from a page shorter than the shingle width', () => {
    expect(shingleHashes('only eight words in this whole short page').size).toBe(0);
    expect(shingleHashes('exactly ten words are present in this particular short page').size).toBe(1);
  });
});

describe('SRCQ-18 hashing is deterministic and a shingle set holds each window once', () => {
  it('gives the same hash for the same shingle every time', () => {
    expect(hashShingle('a b c d e f g h i j')).toBe(hashShingle('a b c d e f g h i j'));
    expect(hashShingle('a b c d e f g h i j')).not.toBe(hashShingle('a b c d e f g h i k'));
  });

  /**
   * The published FNV-1a 32-bit vectors, which any deterministic hash would
   * otherwise pass the test above without matching. ASCII only, deliberately:
   * this runs over UTF-16 code units rather than UTF-8 bytes, so it agrees with
   * the reference exactly up to U+007F and by construction not above it. The
   * divergence is documented on `hashShingle`; the vector pins the half that is
   * supposed to agree.
   */
  it('matches the published FNV-1a 32-bit vectors on ASCII', () => {
    expect(hashShingle('')).toBe(0x811c9dc5);
    expect(hashShingle('a')).toBe(0xe40c292c);
    expect(hashShingle('foobar')).toBe(0xbf9cf968);
  });

  it('is not byte-canonical above U+007F, which is why the vector stops at ASCII', () => {
    // 1812687940 is what UTF-16 code units give; UTF-8 bytes would give
    // 513665217. Asserted so the divergence cannot be "fixed" without noticing.
    expect(hashShingle('é')).toBe(1_812_687_940);
  });

  it('returns an unsigned 32-bit value rather than a negative one', () => {
    for (const shingle of ['zzz', 'the quick brown fox jumps over the lazy dog now', '3 85 per cent']) {
      const h = hashShingle(shingle);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it('counts a repeated window once, as Broder defines the shingle set', () => {
    // Eleven identical windows of ten words collapse to one member.
    const words = Array.from({ length: 20 }, () => 'same').join(' ');
    expect(shingleHashes(words).size).toBe(1);
  });

  it('does not depend on how the text was split across lines', () => {
    const a = shingleHashes(WIRE_PRINTINGS[0]!.text);
    const b = shingleHashes(WIRE_PRINTINGS[0]!.text.replace(/ /g, '\n'));
    expect(b).toEqual(a);
  });
});

describe('SRCQ-15 resemblance, and its boundary', () => {
  it('is 1 for identical text and 0 when either side is empty', () => {
    const s = shingleHashes(WIRE_PRINTINGS[0]!.text);
    expect(resemblance(s, s)).toBe(1);
    expect(resemblance(s, new Set())).toBe(0);
    expect(resemblance(new Set(), s)).toBe(0);
    expect(resemblance(new Set(), new Set())).toBe(0);
  });

  it('is intersection over union', () => {
    // 60 shared out of a union of 140 is 3/7.
    expect(resemblance(setOf(0, 100), setOf(40, 100))).toBeCloseTo(60 / 140, 10);
  });

  /**
   * The bar itself, from both sides.
   *
   * Two sets of 100 sharing k members have resemblance k / (200 - k). k = 82
   * gives 0.6949, k = 83 gives 0.7094; the crossing sits between them, so 82 is
   * below the bar and 83 is above it. The exact-equality case is built
   * separately, because a `>` written for a `>=` passes both of the others.
   */
  it('rejects immediately below the bar and accepts immediately above it', () => {
    const below = resemblance(setOf(0, 100), setOf(18, 100));
    const above = resemblance(setOf(0, 100), setOf(17, 100));
    expect(below).toBeLessThan(SYNDICATION_RESEMBLANCE);
    expect(above).toBeGreaterThan(SYNDICATION_RESEMBLANCE);
    expect(sameStory(setOf(0, 100), setOf(18, 100)).same).toBe(false);
    expect(sameStory(setOf(0, 100), setOf(17, 100)).same).toBe(true);
  });

  it('accepts a pair sitting exactly on the bar, so the comparison is inclusive', () => {
    // 140 shared out of a union of 200 is exactly 0.7.
    const a = setOf(0, 170);
    const b = setOf(30, 170);
    expect(resemblance(a, b)).toBeCloseTo(0.7, 12);
    expect(sameStory(a, b)).toMatchObject({ same: true, basis: 'resemblance' });
  });
});

describe('SRCQ-16 containment, and its boundary', () => {
  it('is taken over the smaller set, so a subset scores 1 in either argument order', () => {
    const big = setOf(0, 300);
    const small = setOf(0, 120);
    expect(containment(big, small)).toBe(1);
    expect(containment(small, big)).toBe(1);
    expect(containment(big, new Set())).toBe(0);
  });

  it('rejects immediately below the containment bar and accepts exactly on it', () => {
    const big = setOf(0, 400);
    expect(containment(big, setOf(0, 100))).toBe(1);
    // 89 of a 100-member set inside the other is 0.89; 90 is exactly 0.90.
    const justUnder = new Set([...setOf(0, 89), ...setOf(1000, 11)]);
    const exactly = new Set([...setOf(0, 90), ...setOf(1000, 10)]);
    expect(containment(big, justUnder)).toBeCloseTo(0.89, 10);
    expect(containment(big, exactly)).toBeCloseTo(0.9, 10);
    expect(sameStory(big, justUnder).same).toBe(false);
    expect(sameStory(big, exactly)).toMatchObject({ same: true, basis: 'containment' });
  });
});

describe('SRCQ-04 a page too short to characterise is never judged the same story', () => {
  it('answers too-short rather than comparing, even for identical text', () => {
    const short = setOf(0, MIN_SHINGLES - 1);
    expect(sameStory(short, short)).toEqual({
      same: false,
      resemblance: 0,
      containment: 0,
      basis: 'too-short',
    });
  });

  it('compares once both sides reach the floor', () => {
    const enough = setOf(0, MIN_SHINGLES);
    expect(sameStory(enough, enough)).toMatchObject({ same: true, basis: 'resemblance' });
  });
});

describe('SRCQ-01 and SRCQ-02 the two directions, on real prose', () => {
  it('scores four printings of one wire story above the bar, in every pair', () => {
    const sets = WIRE_PRINTINGS.map((p) => shingleHashes(p.text));
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        const verdict = sameStory(sets[i]!, sets[j]!);
        expect(verdict.same).toBe(true);
        expect(verdict.resemblance).toBeGreaterThanOrEqual(SYNDICATION_RESEMBLANCE);
      }
    }
  });

  it('scores four independently written articles about the same event far below it', () => {
    const sets = INDEPENDENT_ARTICLES.map((p) => shingleHashes(p.text));
    for (const set of sets) expect(set.size).toBeGreaterThanOrEqual(MIN_SHINGLES);
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        const verdict = sameStory(sets[i]!, sets[j]!);
        expect(verdict.same).toBe(false);
        // Not merely under the bar: in a different part of the range entirely.
        expect(verdict.resemblance).toBeLessThan(0.1);
        // The full verdict, so the third basis value is asserted somewhere.
        expect(verdict.basis).toBe('below-threshold');
      }
    }
  });

  /**
   * The documented range, pinned as a range.
   *
   * `docs/bench/source-quality.md` and the constant's own comment both say the
   * gap between the two fixture families is wide rather than that the bar is
   * finely balanced. Asserting only `>= 0.7` and `< 0.1` would let that claim
   * rot without any test noticing.
   */
  it('holds the measured figures the documentation quotes', () => {
    const wire = WIRE_PRINTINGS.map((p) => shingleHashes(p.text));
    const pairs: number[] = [];
    for (let i = 0; i < wire.length; i += 1) {
      for (let j = i + 1; j < wire.length; j += 1) pairs.push(resemblance(wire[i]!, wire[j]!));
    }
    expect(Math.min(...pairs)).toBeGreaterThanOrEqual(0.83);
    expect(Math.max(...pairs)).toBeLessThanOrEqual(0.86);

    const indep = INDEPENDENT_ARTICLES.map((p) => shingleHashes(p.text));
    for (let i = 0; i < indep.length; i += 1) {
      for (let j = i + 1; j < indep.length; j += 1) {
        expect(resemblance(indep[i]!, indep[j]!)).toBe(0);
      }
    }
  });

  it('does not merge a wire printing with an independent article on the same event', () => {
    const wire = shingleHashes(WIRE_PRINTINGS[0]!.text);
    for (const article of INDEPENDENT_ARTICLES) {
      expect(sameStory(wire, shingleHashes(article.text)).same).toBe(false);
    }
  });
});

describe('SRCQ-03 a part-length republication is caught by containment, not resemblance', () => {
  it('scores under the resemblance bar and over the containment bar', () => {
    const full = shingleHashes(WIRE_PRINTINGS[0]!.text);
    const cut = shingleHashes(WIRE_TRUNCATED.text);
    expect(cut.size).toBeGreaterThanOrEqual(MIN_SHINGLES);
    const verdict = sameStory(full, cut);
    expect(verdict.resemblance).toBeLessThan(SYNDICATION_RESEMBLANCE);
    expect(verdict.containment).toBeGreaterThanOrEqual(SYNDICATION_CONTAINMENT);
    expect(verdict).toMatchObject({ same: true, basis: 'containment' });
  });
});

describe('SRCQ-19 an oversized page is compared on a prefix', () => {
  it('shingles only the first MAX_PAGE_CHARS characters', () => {
    const body = WIRE_PRINTINGS[0]!.text;
    const padded = `${'x '.repeat(MAX_PAGE_CHARS)}${body}`;
    // The body sits entirely beyond the cap, so none of its shingles survive.
    expect(shingleHashes(padded).size).toBeLessThan(shingleHashes(body).size);
    expect(sameStory(shingleHashes(padded), shingleHashes(body)).same).toBe(false);
  });
});

/**
 * Every way a module can reach out, not just the static import form.
 *
 * Exported from this describe block's scope so the scorer's own copy of the
 * check stays identical: two hand-maintained regexes for one rule drift, and the
 * one that drifts is the one nobody re-reads.
 */
export const REACH =
  /(?:from|import|require)\s*\(?\s*['"][^'"]*(?:(?:node:)?(?:fs(?:\/promises)?|net|https?|http2|tls|dns|dgram|child_process)|safe-fetch)(?:\.[jt]s)?['"]|createRequire|\bfetch\s*\(|undici/;

describe('SRCQ-21 the detector reaches no filesystem and no network', () => {
  it('imports nothing that could read a disk or open a socket', () => {
    const source = readFileSync(new URL('./syndication.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(REACH);
  });

  it('would catch such a reach added later, in any of its forms', () => {
    for (const smuggled of [
      "import { readFileSync } from 'node:fs';",
      'import { readFile } from "node:fs/promises";',
      "void import('node:https');",
      "import { connect } from 'node:http2';",
      "import { connect } from 'node:tls';",
      "import { Socket } from 'node:dgram';",
      "const fs = require('fs');",
      "import { createRequire } from 'node:module';",
      'await fetch(url);',
      "import { request } from 'undici';",
      "import { safeFetch } from '../../../src/net/safe-fetch.js';",
    ]) {
      expect(smuggled).toMatch(REACH);
    }
  });
});
