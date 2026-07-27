import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessSupport } from '../../../src/research/corroborate.js';
import { classifySource, profileEvidence } from '../../../src/research/evidence.js';
import { MAX_PAGES, scoreSourceQuality, type SourceQualityScored } from './source-quality.js';
import { MAX_PAGE_CHARS, MIN_SHINGLES, shingleHashes } from './syndication.js';
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

  /**
   * The guarantee at the type level, not only at run time.
   *
   * The runtime assertions above check what this implementation returns. They
   * would not notice either count becoming optional in the interface, which is
   * the change that would let a future caller construct a result carrying only
   * the collapsed figure. The brief forbids exactly that, so it is pinned where
   * it is decided.
   */
  it('cannot express a result that carries only one of the two counts', () => {
    const noRaw = {} as Omit<SourceQualityScored, 'rawIndependentDomains'>;
    const noCollapsed = {} as Omit<SourceQualityScored, 'collapsedIndependentDomains'>;
    // @ts-expect-error the raw count is required; the brief forbids reporting the collapsed figure alone
    const missingRaw: SourceQualityScored = noRaw;
    // @ts-expect-error the collapsed count is required too, so the pair is symmetric
    const missingCollapsed: SourceQualityScored = noCollapsed;
    expect(missingRaw).toBeDefined();
    expect(missingCollapsed).toBeDefined();
  });

  it('carries no count at all on the arm that did not compute one', () => {
    const result = scoreSourceQuality([]);
    expect(result.status).toBe('not-applicable');
    // A zero and an unmeasurable read identically in an average and mean
    // opposite things, so the not-applicable arm carries neither number.
    expect(result).not.toHaveProperty('rawIndependentDomains');
    expect(result).not.toHaveProperty('collapsedIndependentDomains');
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
    expect(result.notes.join(' ')).toContain("1 supplied page(s) were not among the report's citations");
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

describe('SRCQ-22 two separate stories make two separate clusters', () => {
  /**
   * The check that distinguishes a correct link attribution from a plausible
   * wrong one. Every other clustering test here has exactly one cluster, so a
   * filter that handed every link to every cluster would pass all of them.
   */
  const pages = [
    WIRE_PRINTINGS[0]!,
    WIRE_PRINTINGS[1]!,
    { url: 'https://one.other-story.example/piece', text: INDEPENDENT_ARTICLES[0]!.text },
    { url: 'https://two.second-story.example/piece', text: INDEPENDENT_ARTICLES[0]!.text },
  ];
  const result = scored(urlsOf(pages), pages);

  it('collapses four domains to two, not to one', () => {
    expect(result.rawIndependentDomains).toBe(4);
    expect(result.collapsedIndependentDomains).toBe(2);
    expect(result.syndicationClusters).toHaveLength(2);
  });

  it('gives each cluster only its own link, never the other cluster’s', () => {
    for (const cluster of result.syndicationClusters) {
      expect(cluster.domains).toHaveLength(2);
      expect(cluster.links).toHaveLength(1);
      const link = cluster.links[0]!;
      expect(cluster.urls).toContain(link.a);
      expect(cluster.urls).toContain(link.b);
    }
    const clusterA = result.syndicationClusters.find((c) => c.domains.includes('example.com'))!;
    expect(clusterA.domains).toEqual(['example.com', 'example.org']);
    expect(clusterA.links[0]!.a).toContain('example.com');
  });
});

describe('SRCQ-23 a page whose own address is not a web address takes no part', () => {
  it('ignores it rather than letting it merge two cited domains', () => {
    const pages = [
      WIRE_PRINTINGS[0]!,
      { url: 'unknown', text: WIRE_PRINTINGS[1]!.text },
    ];
    const result = scored([WIRE_PRINTINGS[0]!.url, WIRE_PRINTINGS[1]!.url], pages);
    expect(result.comparedPages).toBe(1);
    expect(result.collapsedIndependentDomains).toBe(2);
    expect(result.notes.join(' ')).toContain('1 supplied page(s) carried an address that is not a resolvable web address');
  });
});

describe('SRCQ-24 the source mix is really the product’s, on a fixture that can tell', () => {
  /**
   * Every other fixture here uses `.example` hosts, which `classifySource`
   * leaves `other`. An implementation that hard-coded every source as `other`
   * would pass all of them. This one spans six classes, so it cannot.
   */
  const mixed = [
    'https://www.sec.gov/files/rules/final/2026/33-11000.pdf',
    'https://arxiv.org/abs/2509.04499',
    'https://www.reuters.com/markets/rates-2026-07-27/',
    'https://www.g2.com/products/thing/reviews',
    'https://news.ycombinator.com/item?id=1',
    'https://some-unrecognised-host.example/page',
  ];

  it('reproduces classifySource and profileEvidence exactly, class for class', () => {
    const result = scored(mixed);
    const expectedSources = mixed.map((u) => classifySource(u));
    expect(result.sources).toEqual(expectedSources);
    expect(result.profile).toEqual(profileEvidence(expectedSources));
  });

  it('does not flatten everything into one class', () => {
    const result = scored(mixed);
    const used = Object.entries(result.profile.byType).filter(([, n]) => n > 0);
    expect(used.length).toBeGreaterThanOrEqual(5);
    expect(result.profile.byType.official).toBeGreaterThan(0);
    expect(result.profile.byType.academic).toBeGreaterThan(0);
    expect(result.profile.byType.journalism).toBeGreaterThan(0);
    expect(result.profile.officialShare).toBeGreaterThan(0);
    expect(result.profile.largestSingleDomainShare).toBeGreaterThan(0);
  });
});

describe('SRCQ-25 a cited domain with no page supplied at all', () => {
  it('stays its own source and names the missing page as the cause', () => {
    const cited = [WIRE_PRINTINGS[0]!.url, WIRE_PRINTINGS[1]!.url];
    const result = scored(cited, [WIRE_PRINTINGS[0]!]);
    expect(result.rawIndependentDomains).toBe(2);
    expect(result.collapsedIndependentDomains).toBe(2);
    expect(result.uncheckedDomains).toEqual([
      {
        domain: 'example.org',
        why: 'no page text was supplied for this domain, so it could not be compared; it is counted as its own source',
      },
    ]);
  });

  it('states the direction of the bound rather than reversing it', () => {
    const result = scored([WIRE_PRINTINGS[0]!.url, WIRE_PRINTINGS[1]!.url], [WIRE_PRINTINGS[0]!]);
    const note = result.notes.find((n) => n.includes('untested'))!;
    expect(note).toContain('upper bound on how many independent sources there are');
    expect(note).toContain('lower bound on how much collapsing there is');
  });
});

describe('SRCQ-26 a component beside an untouched domain', () => {
  it('collapses only the component, leaving the independent domain alone', () => {
    const pages = [WIRE_PRINTINGS[0]!, WIRE_PRINTINGS[1]!, INDEPENDENT_ARTICLES[3]!];
    const result = scored(urlsOf(pages), pages);
    expect(result.rawIndependentDomains).toBe(3);
    expect(result.collapsedIndependentDomains).toBe(2);
    expect(result.syndicationClusters).toHaveLength(1);
    expect(result.syndicationClusters[0]!.domains).toEqual(['example.com', 'example.org']);
  });
});

describe('SRCQ-27 dedupe does not over-reach', () => {
  it('keeps two distinct paths on one domain as two sources', () => {
    const urls = [WIRE_PRINTINGS[0]!.url, ORIGINAL_ON_SYNDICATING_DOMAIN.url];
    const result = scored(urls);
    expect(result.sources).toHaveLength(2);
    // Two sources, one publisher: the domain count is what collapses them, and
    // it is supposed to.
    expect(result.rawIndependentDomains).toBe(1);
  });

  it('deduplicates a supplied page by canonical form, not by raw equality', () => {
    const pages = [
      WIRE_PRINTINGS[0]!,
      { url: `${WIRE_PRINTINGS[0]!.url}?utm_campaign=x`, text: WIRE_PRINTINGS[0]!.text },
      WIRE_PRINTINGS[1]!,
    ];
    const result = scored(urlsOf(WIRE_PRINTINGS).slice(0, 2), pages);
    expect(result.comparedPages).toBe(2);
    expect(result.notes.join(' ')).toContain('1 supplied page(s) repeated a page already supplied');
  });
});

describe('SRCQ-28 a page the report did not cite cannot merge two publishers', () => {
  it('rejects an uncited page even when it sits on a cited domain', () => {
    // Both cited pages are unrelated originals. The two wire copies are on the
    // same two domains but at paths the report never cited, so on a
    // domain-level rule they would merge the publishers and on a URL-level rule
    // they cannot.
    const cited = [
      { url: 'https://one.alpha.example/original', text: INDEPENDENT_ARTICLES[0]!.text },
      { url: 'https://two.beta.example/original', text: INDEPENDENT_ARTICLES[1]!.text },
    ];
    const uncited = [
      { url: 'https://one.alpha.example/wire-copy', text: WIRE_PRINTINGS[0]!.text },
      { url: 'https://two.beta.example/wire-copy', text: WIRE_PRINTINGS[1]!.text },
    ];
    const result = scored(urlsOf(cited), [...cited, ...uncited]);
    expect(result.rawIndependentDomains).toBe(2);
    expect(result.collapsedIndependentDomains).toBe(2);
    expect(result.syndicationClusters).toEqual([]);
    expect(result.notes.join(' ')).toContain("2 supplied page(s) were not among the report's citations");
  });
});

describe('SRCQ-29 the page ceiling bounds what is processed, not what survives', () => {
  it('reports the ceiling even when every earlier page was too short to compare', () => {
    const shortPages = Array.from({ length: MAX_PAGES }, (_, i) => ({
      url: `https://short${String(i)}.example/page`,
      text: 'far too little text to characterise this page at all',
    }));
    const real = { url: 'https://real.example/story', text: WIRE_PRINTINGS[0]!.text };
    const pages = [...shortPages, real];
    const result = scored(urlsOf(pages), pages);
    // The bound sits in front of the shingling, so the real page past it is
    // unexamined rather than quietly processed because nothing before it
    // happened to be comparable.
    expect(result.comparedPages).toBe(0);
    expect(result.unexaminedPages).toBe(1);
  });
});

describe('SRCQ-30 a domain hitting two unchecked causes at once names both', () => {
  it('does not report only the first cause it happened to test for', () => {
    const shortFiller = Array.from({ length: MAX_PAGES - 1 }, (_, i) => ({
      url: `https://filler${String(i)}.example/page`,
      text: 'too short',
    }));
    const twoCause = [
      { url: 'https://both.example/short', text: 'also far too short to characterise' },
      { url: 'https://both.example/long', text: WIRE_PRINTINGS[0]!.text },
    ];
    // The first of the pair is processed (and too short); the second lands past
    // the ceiling, so the domain hits both causes.
    const pages = [...shortFiller, ...twoCause];
    const result = scored(urlsOf(pages), pages);
    const both = result.uncheckedDomains.find((u) => u.domain === 'both.example')!;
    expect(both.why).toContain('too little text to characterise');
    expect(both.why).toContain('past the 200-page ceiling');
  });
});

describe('SRCQ-31 an unusable page address is reported as that, not as something else', () => {
  it('gives an invalid address its own cause rather than the uncited one', () => {
    const pages = [WIRE_PRINTINGS[0]!, { url: 'unknown', text: WIRE_PRINTINGS[1]!.text }];
    const result = scored([WIRE_PRINTINGS[0]!.url, WIRE_PRINTINGS[1]!.url], pages);
    const joined = result.notes.join(' ');
    expect(joined).toContain('1 supplied page(s) carried an address that is not a resolvable web address');
    expect(joined).not.toContain("were not among the report's citations");
  });
});

describe('SRCQ-32 the scorer repeats the length floor, so the floor is exercised there too', () => {
  it('compares and merges two pages sitting exactly on the floor', () => {
    // 109 distinct words gives exactly 100 ten-word windows.
    const words = Array.from({ length: MIN_SHINGLES + 9 }, (_, i) => `w${String(i)}`).join(' ');
    const pages = [
      { url: 'https://a.floor-one.example/p', text: words },
      { url: 'https://b.floor-two.example/p', text: words },
    ];
    expect(shingleHashes(words).size).toBe(MIN_SHINGLES);
    const result = scored(urlsOf(pages), pages);
    expect(result.comparedPages).toBe(2);
    expect(result.collapsedIndependentDomains).toBe(1);
  });

  it('leaves them alone one shingle below the floor', () => {
    const words = Array.from({ length: MIN_SHINGLES + 8 }, (_, i) => `w${String(i)}`).join(' ');
    const pages = [
      { url: 'https://a.floor-one.example/p', text: words },
      { url: 'https://b.floor-two.example/p', text: words },
    ];
    expect(shingleHashes(words).size).toBe(MIN_SHINGLES - 1);
    const result = scored(urlsOf(pages), pages);
    expect(result.comparedPages).toBe(0);
    expect(result.collapsedIndependentDomains).toBe(2);
  });
});

describe('SRCQ-33 a publisher bridging two different stories', () => {
  /**
   * The transitive case the domain-level rule has to own. B carries story X,
   * which A also carries, and story Y, which C also carries. A and C share
   * nothing. Counting publishers merges all three; counting stories would not.
   * The behaviour is deliberate and is documented above the pairwise loop, so
   * this test exists to pin it rather than to approve of it.
   */
  const pages = [
    { url: 'https://a.bridge-a.example/x', text: WIRE_PRINTINGS[0]!.text },
    { url: 'https://b.bridge-b.example/x', text: WIRE_PRINTINGS[1]!.text },
    { url: 'https://b.bridge-b.example/y', text: INDEPENDENT_ARTICLES[0]!.text },
    { url: 'https://c.bridge-c.example/y', text: INDEPENDENT_ARTICLES[0]!.text },
  ];

  it('merges all three publishers even though the ends share no story', () => {
    const result = scored(urlsOf(pages), pages);
    expect(result.rawIndependentDomains).toBe(3);
    expect(result.collapsedIndependentDomains).toBe(1);
    expect(result.syndicationClusters).toHaveLength(1);
    expect(result.syndicationClusters[0]!.links).toHaveLength(2);
  });

  it('confirms the ends really do share nothing, so the merge is the bridge', () => {
    const ends = [pages[0]!, pages[3]!];
    const result = scored(urlsOf(ends), ends);
    expect(result.collapsedIndependentDomains).toBe(2);
  });
});

describe('SRCQ-34 a cluster lists the pages that matched, and only those', () => {
  it('leaves out an original piece on a merged domain', () => {
    const pages = [...WIRE_PRINTINGS.slice(0, 2), ORIGINAL_ON_SYNDICATING_DOMAIN];
    const result = scored(urlsOf(pages), pages);
    const cluster = result.syndicationClusters[0]!;
    expect(cluster.urls).toEqual([WIRE_PRINTINGS[0]!.url, WIRE_PRINTINGS[1]!.url].sort());
    expect(cluster.urls).not.toContain(ORIGINAL_ON_SYNDICATING_DOMAIN.url);
    // It is not lost: the note is where it surfaces.
    expect(result.notes.join(' ')).toContain('matching nothing else');
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
