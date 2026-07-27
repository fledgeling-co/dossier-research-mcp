import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessSupport } from '../../../src/research/corroborate.js';
import { classifySource, profileEvidence } from '../../../src/research/evidence.js';
import { MAX_PAGES, scoreSourceQuality, type SourceQualityScored } from './source-quality.js';
import { MAX_PAGE_CHARS, MIN_SHINGLES } from './syndication.js';
import {
  BOILERPLATE_PAGES,
  INDEPENDENT_ARTICLES,
  ORIGINAL_ON_SYNDICATING_DOMAIN,
  WIRE_PRINTINGS,
  WIRE_TRUNCATED,
} from './wire-fixtures.js';

const scored = (
  urls: readonly string[],
  pages: readonly { url: string; text: string }[] = [],
): SourceQualityScored => {
  const result = scoreSourceQuality(urls, pages);
  if (result.status !== 'scored') {
    throw new Error(`expected a scored result, got ${result.status}: ${result.why}`);
  }
  return result;
};

const urlsOf = (pages: readonly { url: string }[]): string[] => pages.map((p) => p.url);

describe('SRCQ-01 four printings of one wire story collapse to one source', () => {
  const result = scored(urlsOf(WIRE_PRINTINGS), WIRE_PRINTINGS);

  it('collapses four domains to one', () => {
    expect(result.collapsedIndependentDomains).toBe(1);
  });

  it('still reports the raw count as four, so the judgement can be disagreed with', () => {
    expect(result.rawIndependentDomains).toBe(4);
  });

  it('reports one cluster naming all four domains and the pages that joined them', () => {
    expect(result.syndicationClusters).toHaveLength(1);
    const cluster = result.syndicationClusters[0]!;
    expect(cluster.domains).toEqual(['example.com', 'example.io', 'example.net', 'example.org']);
    expect(cluster.urls).toHaveLength(4);
    // Six pairs among four pages, every one of them a link.
    expect(cluster.links).toHaveLength(6);
    for (const link of cluster.links) {
      expect(link.basis).toBe('resemblance');
      expect(link.resemblance).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('says both figures in a note rather than leaving the reader to subtract', () => {
    expect(result.notes.join(' ')).toContain('4 independent domain(s) collapse to 1');
  });
});

describe('SRCQ-02 four independent articles on one event do not collapse', () => {
  const result = scored(urlsOf(INDEPENDENT_ARTICLES), INDEPENDENT_ARTICLES);

  it('leaves the raw and collapsed counts equal at four', () => {
    expect(result.rawIndependentDomains).toBe(4);
    expect(result.collapsedIndependentDomains).toBe(4);
  });

  it('finds no cluster at all, and compared every page', () => {
    expect(result.syndicationClusters).toEqual([]);
    expect(result.comparedPages).toBe(4);
    expect(result.uncheckedDomains).toEqual([]);
  });
});

describe('SRCQ-03 a part-length republication is still caught', () => {
  const pages = [WIRE_PRINTINGS[0]!, WIRE_TRUNCATED];
  const result = scored(urlsOf(pages), pages);

  it('merges the two domains on containment rather than resemblance', () => {
    expect(result.rawIndependentDomains).toBe(2);
    expect(result.collapsedIndependentDomains).toBe(1);
    expect(result.syndicationClusters[0]?.links[0]?.basis).toBe('containment');
  });

  it('carries the scores that decided it, both of them', () => {
    const link = result.syndicationClusters[0]!.links[0]!;
    expect(link.resemblance).toBeLessThan(0.7);
    expect(link.containment).toBeGreaterThanOrEqual(0.9);
  });
});

describe('SRCQ-04 pages too short to characterise never collapse their domains', () => {
  const result = scored(urlsOf(BOILERPLATE_PAGES), BOILERPLATE_PAGES);

  it('leaves two identical paywall notices as two independent sources', () => {
    expect(result.rawIndependentDomains).toBe(2);
    expect(result.collapsedIndependentDomains).toBe(2);
    expect(result.syndicationClusters).toEqual([]);
    expect(result.comparedPages).toBe(0);
  });

  it('names both domains as unchecked, with the length as the reason', () => {
    expect(result.uncheckedDomains.map((u) => u.domain)).toEqual(['example.build', 'example.zone']);
    for (const unchecked of result.uncheckedDomains) {
      expect(unchecked.why).toContain(String(MIN_SHINGLES));
      expect(unchecked.why).toContain('too little text');
    }
  });

  it('warns that syndication among the unchecked is untested rather than ruled out', () => {
    expect(result.notes.join(' ')).toContain('untested');
  });
});

describe('SRCQ-05 syndication is transitive', () => {
  /**
   * A chain, not a clique. The first and last pages share nothing directly: each
   * is one half of the wire body, with only a small overlap in the middle, and
   * the middle page is the full story that contains both. Handling this as a set
   * of independent pairs would report two sources where there is one.
   */
  const full = WIRE_PRINTINGS[0]!.text;
  const words = full.split(' ');
  const head = words.slice(0, Math.floor(words.length * 0.5)).join(' ');
  const tail = words.slice(Math.floor(words.length * 0.5)).join(' ');
  const chain = [
    { url: 'https://head.chain-a.example/story', text: head },
    { url: 'https://middle.chain-b.example/story', text: full },
    { url: 'https://tail.chain-c.example/story', text: tail },
  ];

  it('merges all three when the ends only meet through the middle', () => {
    const result = scored(urlsOf(chain), chain);
    expect(result.rawIndependentDomains).toBe(3);
    expect(result.collapsedIndependentDomains).toBe(1);
    expect(result.syndicationClusters[0]?.domains).toHaveLength(3);
  });

  it('is a real chain: the two ends do not match each other directly', () => {
    const ends = [chain[0]!, chain[2]!];
    const result = scored(urlsOf(ends), ends);
    expect(result.collapsedIndependentDomains).toBe(2);
    expect(result.syndicationClusters).toEqual([]);
  });
});

describe('SRCQ-06 the raw count is the product’s own, by three paths that agree', () => {
  it('agrees with assessSupport and with profileEvidence over the same URLs', () => {
    const urls = [...urlsOf(WIRE_PRINTINGS), ...urlsOf(INDEPENDENT_ARTICLES)];
    const result = scored(urls);
    const direct = assessSupport([{ provider: 'x', text: '', urls }]).independentDomains;
    const viaProfile = profileEvidence(urls.map((u) => classifySource(u))).distinctDomains;
    expect(result.rawIndependentDomains).toBe(direct);
    expect(result.rawIndependentDomains).toBe(viaProfile);
    expect(result.profile.distinctDomains).toBe(direct);
  });

  it('still agrees once unusable citations are mixed in, so both counts see one population', () => {
    const urls = [...urlsOf(WIRE_PRINTINGS), 'unknown', 'N/A', 'source unavailable'];
    const result = scored(urls);
    // assessSupport discards the three non-URLs; so must the scorer, or the two
    // counts would be describing different sets of links.
    expect(result.rawIndependentDomains).toBe(
      assessSupport([{ provider: 'x', text: '', urls }]).independentDomains,
    );
    expect(result.rawIndependentDomains).toBe(4);
    expect(result.profile.distinctDomains).toBe(4);
  });
});

describe('SRCQ-07 citations that are not web addresses are discarded once, up front', () => {
  const result = scored([...urlsOf(WIRE_PRINTINGS), 'unknown', 'ftp://old.example.com/x', '']);

  it('keeps them out of the source list entirely', () => {
    expect(result.sources).toHaveLength(4);
    expect(result.discardedCitations).toEqual(['unknown', 'ftp://old.example.com/x', '']);
  });

  it('reports the discard, so the denominator is not silently different', () => {
    expect(result.notes.join(' ')).toContain('3 citation(s) were not resolvable web addresses');
  });
});

describe('SRCQ-08 nothing usable is not-applicable, never a zero', () => {
  it('returns not-applicable for a report that cited nothing', () => {
    const result = scoreSourceQuality([]);
    expect(result.status).toBe('not-applicable');
    if (result.status !== 'not-applicable') return;
    expect(result.why).toContain('An empty set is not an independent one');
  });

  it('returns not-applicable, naming the count, when every citation was unusable', () => {
    const result = scoreSourceQuality(['unknown', 'not available', 'see above']);
    expect(result.status).toBe('not-applicable');
    if (result.status !== 'not-applicable') return;
    expect(result.why).toContain('none of the 3 citation(s)');
    expect(result.discardedCitations).toHaveLength(3);
  });
});

describe('SRCQ-09 both counts always travel together', () => {
  it('carries the raw figure even when nothing collapsed', () => {
    const result = scored(urlsOf(INDEPENDENT_ARTICLES), INDEPENDENT_ARTICLES);
    expect(result).toHaveProperty('rawIndependentDomains');
    expect(result).toHaveProperty('collapsedIndependentDomains');
  });

  it('carries the raw figure even when everything collapsed', () => {
    const result = scored(urlsOf(WIRE_PRINTINGS), WIRE_PRINTINGS);
    expect(result.rawIndependentDomains).toBe(4);
    expect(result.collapsedIndependentDomains).toBe(1);
  });

  it('never reports a collapsed count above the raw one', () => {
    for (const pages of [WIRE_PRINTINGS, INDEPENDENT_ARTICLES, BOILERPLATE_PAGES]) {
      const result = scored(urlsOf(pages), pages);
      expect(result.collapsedIndependentDomains).toBeLessThanOrEqual(result.rawIndependentDomains);
      expect(result.collapsedIndependentDomains).toBeGreaterThan(0);
    }
  });

  it('grades the source mix with the product’s own classifier rather than a second one', () => {
    const result = scored(urlsOf(WIRE_PRINTINGS), WIRE_PRINTINGS);
    expect(result.profile.byType).toEqual(
      profileEvidence(urlsOf(WIRE_PRINTINGS).map((u) => classifySource(u))).byType,
    );
  });
});

describe('SRCQ-10 a page the report never cited takes no part', () => {
  it('cannot merge two cited domains through an uncited third page', () => {
    const cited = [WIRE_PRINTINGS[0]!.url, WIRE_PRINTINGS[1]!.url];
    // Every page is the same wire story, but the third is on an uncited domain.
    const pages = [...WIRE_PRINTINGS.slice(0, 2), WIRE_PRINTINGS[2]!];
    const result = scored(cited, pages);
    expect(result.rawIndependentDomains).toBe(2);
    expect(result.syndicationClusters[0]?.domains).toEqual(['example.com', 'example.org']);
    expect(result.notes.join(' ')).toContain('1 supplied page(s) were on a domain the report did not cite');
  });

  it('ignores a repeated page rather than comparing it with itself', () => {
    const pages = [WIRE_PRINTINGS[0]!, WIRE_PRINTINGS[0]!, WIRE_PRINTINGS[1]!];
    const result = scored(urlsOf(WIRE_PRINTINGS).slice(0, 2), pages);
    expect(result.comparedPages).toBe(2);
  });
});

describe('SRCQ-11 the judgement calls are returned as values', () => {
  it('returns every threshold and cap it applied', () => {
    const result = scored(urlsOf(WIRE_PRINTINGS), WIRE_PRINTINGS);
    expect(result.thresholds).toEqual({
      resemblance: 0.7,
      containment: 0.9,
      shingleWords: 10,
      minShingles: MIN_SHINGLES,
      maxPageChars: MAX_PAGE_CHARS,
      maxPages: MAX_PAGES,
    });
  });
});

describe('SRCQ-12 the same page cited three ways is one source', () => {
  it('deduplicates by canonical URL before either count', () => {
    const base = WIRE_PRINTINGS[0]!.url;
    const result = scored([
      base,
      `${base}?utm_source=newsletter`,
      `${base}#the-headline`,
      base.replace('https://', 'https://www.'),
    ]);
    expect(result.sources).toHaveLength(1);
    expect(result.rawIndependentDomains).toBe(1);
    expect(result.collapsedIndependentDomains).toBe(1);
  });
});

describe('SRCQ-13 a domain carrying both the wire and its own original piece', () => {
  const pages = [...WIRE_PRINTINGS.slice(0, 2), ORIGINAL_ON_SYNDICATING_DOMAIN];
  const result = scored(urlsOf(pages), pages);

  it('merges the domain on the strength of the wire copy', () => {
    expect(result.rawIndependentDomains).toBe(2);
    expect(result.collapsedIndependentDomains).toBe(1);
  });

  it('names the understatement rather than letting the merge look complete', () => {
    const note = result.notes.find((n) => n.includes('matching nothing else'));
    expect(note).toBeDefined();
    expect(note).toContain('example.com');
    expect(note).toContain('understates independence');
  });
});

describe('SRCQ-14 two pages on one domain never form a cluster', () => {
  it('does not report a single-domain cluster for two copies on the same site', () => {
    const pages = [
      { url: 'https://a.solo.example/one', text: WIRE_PRINTINGS[0]!.text },
      { url: 'https://b.solo.example/two', text: WIRE_PRINTINGS[1]!.text },
    ];
    const result = scored(urlsOf(pages), pages);
    expect(result.rawIndependentDomains).toBe(1);
    expect(result.collapsedIndependentDomains).toBe(1);
    expect(result.syndicationClusters).toEqual([]);
  });
});

describe('SRCQ-19 and SRCQ-20 the resource bounds report themselves', () => {
  it('names a page it compared on a prefix only', () => {
    const long = {
      url: WIRE_PRINTINGS[0]!.url,
      text: WIRE_PRINTINGS[0]!.text + ' padding'.repeat(MAX_PAGE_CHARS),
    };
    const pages = [long, WIRE_PRINTINGS[1]!];
    const result = scored(urlsOf(pages), pages);
    expect(result.truncatedPages).toEqual([long.url]);
    expect(result.notes.join(' ')).toContain('were compared on the first');
  });

  it('reports pages past the ceiling as unexamined rather than dropping them quietly', () => {
    // Genuinely distinct registrable domains, so the pairwise loop really runs
    // at the ceiling rather than short-circuiting on the same-domain skip.
    const many = Array.from({ length: MAX_PAGES + 3 }, (_, i) => ({
      url: `https://site${String(i)}.example/story`,
      text: INDEPENDENT_ARTICLES[i % INDEPENDENT_ARTICLES.length]!.text,
    }));
    const result = scored(urlsOf(many), many);
    expect(result.rawIndependentDomains).toBe(MAX_PAGES + 3);
    expect(result.comparedPages).toBe(MAX_PAGES);
    expect(result.unexaminedPages).toBe(3);
    // The three past the ceiling stay their own sources, and are named as
    // unchecked for the right reason: a page that arrived and was never looked
    // at is a different problem from a page that was never supplied, and
    // reporting them identically sends whoever reads it to the wrong place.
    expect(result.uncheckedDomains).toHaveLength(3);
    for (const unchecked of result.uncheckedDomains) {
      expect(unchecked.why).toContain('past the 200-page ceiling');
    }
    expect(result.notes.join(' ')).toContain('were not examined at all');
  });
});

describe('SRCQ-21 the scorer reaches no filesystem and no network', () => {
  const REACH =
    /(?:from|import|require)\s*\(?\s*['"](?:node:)?(?:fs(?:\/promises)?|net|http|https|dns|child_process)['"]|createRequire|\bfetch\s*\(|undici/;

  it('imports nothing that could read a disk or open a socket', () => {
    const source = readFileSync(new URL('./source-quality.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(REACH);
  });

  it('is deterministic: the same input scores identically twice', () => {
    const a = scored(urlsOf(WIRE_PRINTINGS), WIRE_PRINTINGS);
    const b = scored(urlsOf(WIRE_PRINTINGS), WIRE_PRINTINGS);
    expect(b).toEqual(a);
  });
});
