import { describe, expect, it } from 'vitest';
import {
  overlapCurve,
  OVERLAP_IS_NOT_AN_OBJECTIVE,
  sourceOverlapProfile,
} from './overlap.js';
import * as overlapModule from './overlap.js';
import { eccentricTrio, member } from './fixtures.js';

describe('pairwise source overlap (COMB-09)', () => {
  it('is Jaccard over canonical URLs', () => {
    // a: {1,2,3}  b: {2,3,4}  shared 2, union 4 -> 0.5
    const a = member('a', ['https://x.com/1', 'https://x.com/2', 'https://x.com/3']);
    const b = member('b', ['https://x.com/2', 'https://x.com/3', 'https://x.com/4']);
    const profile = sourceOverlapProfile([a, b]);
    expect(profile.pairs).toHaveLength(1);
    expect(profile.pairs[0]!.urlJaccard).toBeCloseTo(0.5);
    expect(profile.pairs[0]!.sharedUrls).toBe(2);
  });

  it('counts one page cited three ways as one source, not three matches', () => {
    const a = member('a', ['https://x.com/p?utm_source=a', 'https://x.com/p#top']);
    const b = member('b', ['https://x.com/p']);
    const profile = sourceOverlapProfile([a, b]);
    expect(profile.pairs[0]!.urlJaccard).toBe(1);
    expect(profile.pairs[0]!.sharedUrls).toBe(1);
  });

  it('is zero when two members share nothing', () => {
    const profile = sourceOverlapProfile([
      member('a', ['https://x.com/1']),
      member('b', ['https://y.com/1']),
    ]);
    expect(profile.pairs[0]!.urlJaccard).toBe(0);
  });

  it('has no pairs, and no mean, with a single member', () => {
    const profile = sourceOverlapProfile([member('solo', ['https://x.com/1'])]);
    expect(profile.pairs).toEqual([]);
    expect(profile.meanUrlJaccard).toBeUndefined();
    expect(profile.urlToDomainGap).toBeUndefined();
  });
});

describe('domain overlap and the gap (COMB-10)', () => {
  it('is never below URL overlap', () => {
    const a = member('a', ['https://news.example.com/one', 'https://news.example.com/two']);
    const b = member('b', ['https://news.example.com/three']);
    const profile = sourceOverlapProfile([a, b]);
    const pair = profile.pairs[0]!;
    // Different pages, same site: no URL overlap at all, complete domain overlap.
    expect(pair.urlJaccard).toBe(0);
    expect(pair.domainJaccard).toBe(1);
    expect(pair.domainJaccard).toBeGreaterThanOrEqual(pair.urlJaccard);
  });

  it('reports the gap, which is the informative part', () => {
    const a = member('a', ['https://news.example.com/one']);
    const b = member('b', ['https://news.example.com/two']);
    const profile = sourceOverlapProfile([a, b]);
    // Members reading different pages on the same site are less independent
    // than the URL count alone suggests, and the size of the gap says so.
    expect(profile.urlToDomainGap).toBeCloseTo(1);
  });

  it('is zero on both when the registrable domains genuinely differ', () => {
    // Two different registrable domains, not two subdomains of one: `one.example.com`
    // and `two.example.com` both reduce to `example.com`, which is the domain
    // count doing its job and would make this assertion measure the opposite.
    const profile = sourceOverlapProfile([
      member('a', ['https://alpha.org/x']),
      member('b', ['https://beta.net/x']),
    ]);
    expect(profile.urlToDomainGap).toBe(0);
  });

  it('treats two subdomains of one site as one domain, so the gap opens', () => {
    const profile = sourceOverlapProfile([
      member('a', ['https://one.example.com/x']),
      member('b', ['https://two.example.com/x']),
    ]);
    expect(profile.pairs[0]!.urlJaccard).toBe(0);
    expect(profile.pairs[0]!.domainJaccard).toBe(1);
  });
});

describe('robustness (COMB-11)', () => {
  it('is the share of the union surviving the loss of the most load-bearing member', () => {
    // union = {shared, a-own, b1, b2, b3}: 5 URLs.
    // Dropping a loses only a-own -> 4/5. Dropping b loses b1,b2,b3 -> 2/5.
    const a = member('a', ['https://s.com/shared', 'https://a.com/own']);
    const b = member('b', [
      'https://s.com/shared',
      'https://b.com/1',
      'https://b.com/2',
      'https://b.com/3',
    ]);
    const profile = sourceOverlapProfile([a, b]);
    expect(profile.robustness.unionSize).toBe(5);
    const byId = new Map(profile.robustness.perMember.map((m) => [m.memberId, m]));
    expect(byId.get('a')!.survivingShare).toBeCloseTo(4 / 5);
    expect(byId.get('b')!.survivingShare).toBeCloseTo(2 / 5);
    expect(profile.robustness.worstCaseSurvivingShare).toBeCloseTo(2 / 5);
  });

  it('is 1 when every source is found by more than one member', () => {
    const urls = ['https://x.com/1', 'https://x.com/2'];
    const profile = sourceOverlapProfile([member('a', urls), member('b', urls)]);
    expect(profile.robustness.worstCaseSurvivingShare).toBe(1);
  });

  it('is 0 for a combination of one, which loses everything with its only member', () => {
    const profile = sourceOverlapProfile([member('solo', ['https://x.com/1'])]);
    expect(profile.robustness.worstCaseSurvivingShare).toBe(0);
  });
});

describe('the eccentricity counterweight (COMB-12, COMB-13)', () => {
  const { members, centralUrls } = eccentricTrio();
  const profile = sourceOverlapProfile(members);
  const byId = new Map(profile.centrality.perMember.map((m) => [m.memberId, m]));

  it('identifies the sources more than half the members found', () => {
    expect([...profile.centrality.centralUrls].sort()).toEqual([...centralUrls].sort());
  });

  it('gives the obscure member the most unique sources', () => {
    // Breadth, and nothing more. Named `uniqueUrls` and never `value`.
    expect(byId.get('obscure')!.uniqueUrls).toBe(5);
    expect(byId.get('core-a')!.uniqueUrls).toBe(1);
    expect(byId.get('core-b')!.uniqueUrls).toBe(1);
  });

  it('gives the obscure member the lowest overlap with everyone', () => {
    const withObscure = profile.pairs.filter((p) => p.a === 'obscure' || p.b === 'obscure');
    expect(withObscure).toHaveLength(2);
    for (const p of withObscure) expect(p.urlJaccard).toBe(0);
  });

  it('and gives it the highest missed-central count, which is what says eccentric rather than broad', () => {
    // This is the whole point. On unique sources and on overlap the obscure
    // member looks like the most valuable one in the combination. Only
    // missedCentral separates "reads what nobody else reads" from "misses what
    // everybody else found".
    expect(byId.get('obscure')!.missedCentral).toBe(2);
    expect(byId.get('core-a')!.missedCentral).toBe(0);
    expect(byId.get('core-b')!.missedCentral).toBe(0);
  });

  it('reports the central threshold so a reader who disagrees can recompute', () => {
    expect(profile.centrality.centralThreshold).toBe(1.5);
  });
});

describe('overlap is never given a direction (COMB-14)', () => {
  it('carries the caution on every profile', () => {
    const profile = sourceOverlapProfile([member('a', []), member('b', [])]);
    expect(profile.caution).toBe(OVERLAP_IS_NOT_AN_OBJECTIVE);
    expect(profile.caution).toMatch(/not monotonically better/i);
    expect(profile.caution).toMatch(/optimum in the middle/i);
  });

  it('exports no function that ranks or selects combinations by overlap', () => {
    // The enforcement, asserted rather than reviewed. A `lowestOverlap` or a
    // `bestOverlap` would decide the very question the brief says is a finding.
    const exported = Object.keys(overlapModule);
    for (const name of exported) {
      expect(name).not.toMatch(/^(best|lowest|highest|rank|sortBy|optimal)/i);
    }
    expect(exported).not.toContain('bestOverlap');
    expect(exported).not.toContain('lowestOverlap');
  });

  it('returns curve bins in ascending overlap with no ordering on quality', () => {
    const bins = overlapCurve(
      [
        { id: 'high', meanUrlJaccard: 0.85, score: 0.9 },
        { id: 'mid', meanUrlJaccard: 0.45, score: 0.95 },
        { id: 'low', meanUrlJaccard: 0.05, score: 0.3 },
      ],
      10,
    );
    expect(bins).toHaveLength(10);
    for (let i = 1; i < bins.length; i += 1) {
      expect(bins[i]!.lower).toBeGreaterThan(bins[i - 1]!.lower);
    }
    // The best score here sits in the MIDDLE band, which is exactly the shape
    // the brief expects and exactly what a "lower is better" score would hide.
    const best = bins.reduce((a, b) => (b.count > 0 && b.maxScore > a.maxScore ? b : a), bins[0]!);
    expect(best.ids).toEqual(['mid']);
  });

  it('puts a Jaccard of exactly 1 in the top band rather than dropping it', () => {
    const bins = overlapCurve([{ id: 'all', meanUrlJaccard: 1, score: 0.5 }], 4);
    expect(bins[3]!.count).toBe(1);
  });

  it('refuses a non-positive bin count', () => {
    expect(() => overlapCurve([], 0)).toThrow(/positive integer/i);
  });
});

describe('a combination of one is excluded from the curve (COMB-15)', () => {
  it('is not binned at zero, which would invent a trend', () => {
    const bins = overlapCurve([
      { id: 'solo', meanUrlJaccard: undefined, score: 0.9 },
      { id: 'pair', meanUrlJaccard: 0.5, score: 0.4 },
    ]);
    const total = bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(1);
    expect(bins[0]!.ids).not.toContain('solo');
  });
});
