import { describe, expect, it } from 'vitest';
import { assessSupport } from '../src/research/corroborate.js';
import {
  buildRegistry,
  classifySource,
  countsAsCorroboration,
  profileEvidence,
  renderProfile,
  renderTrace, assessStaleness } from '../src/research/evidence.js';

/**
 * Evidence governance.
 *
 * The tests worth having here are the ones that pin the *honesty* of the
 * layer rather than its arithmetic: that an unknown domain is admitted as
 * unknown, that a user's own file is never independent corroboration, and that
 * a failed floor is reported rather than enforced.
 */

describe('source classification is conservative on purpose', () => {
  it('recognises the classes it can actually recognise', () => {
    expect(classifySource('https://www.sec.gov/filing/x').type).toBe('official');
    expect(classifySource('https://arxiv.org/abs/2506.12594').type).toBe('academic');
    expect(classifySource('https://www.reuters.com/tech/x').type).toBe('journalism');
    expect(classifySource('https://www.reddit.com/r/x/comments/y').type).toBe('community');
    expect(classifySource('https://www.g2.com/products/x').type).toBe('secondary-industry');
  });

  it('admits when it does not know rather than guessing', () => {
    // An over-eager classifier lets a report pad its "official share" with
    // whatever happens to sit on a .io domain, which is worse than not knowing.
    const s = classifySource('https://some-startup.io/blog/we-are-the-best');
    expect(s.type).toBe('other');
    expect(s.basis).toMatch(/deliberately left unclassified/);
  });

  it('marks a paywalled or login-gated source semi-public, from its verdict', () => {
    const s = classifySource('https://www.wsj.com/articles/x', { verdict: 'blocked' });
    expect(s.accessibility).toBe('semi-public');
    expect(s.type).toBe('journalism');
  });

  it('never lets a user’s own document corroborate an external fact', () => {
    // Circular verification: a report that looks sourced and proves nothing.
    const own = classifySource('file:///Users/me/notes.md', { local: true });
    expect(own.accessibility).toBe('private-user-owned');
    expect(countsAsCorroboration(own)).toBe(false);
    expect(countsAsCorroboration(classifySource('https://example.gov/x'))).toBe(true);
    // A corpus document is the user's own too, however useful it is.
    expect(countsAsCorroboration(classifySource('https://x.com/a', { fromCorpus: true }))).toBe(false);
  });

  it('collapses subdomains and tracking parameters before counting domains', () => {
    expect(classifySource('https://docs.example.com/a?utm_source=x').domain).toBe('example.com');
    expect(classifySource('https://blog.example.com/b').domain).toBe('example.com');
  });
});

describe('quality gates are advisory floors, not pass/fail gates', () => {
  const many = (host: string, n: number) =>
    Array.from({ length: n }, (_, i) => classifySource(`https://${host}/${String(i)}`));

  it('reports a failed floor rather than refusing anything', () => {
    // A report built on one extraordinary primary document fails the mix and
    // is still the right report to publish.
    const profile = profileEvidence([classifySource('https://leaked-docs.example.org/memo')]);
    expect(profile.allGatesMet).toBe(false);
    expect(renderProfile(profile)).toMatch(/advisory/);
    // The point: nothing here throws, and nothing withholds the report.
    expect(profile.sources).toHaveLength(1);
  });

  it('catches one domain wearing several hats', () => {
    const sources = [...many('vendor.com', 8), ...many('other.org', 2)];
    const profile = profileEvidence(sources);
    expect(profile.largestSingleDomainShare).toBeCloseTo(0.8);
    expect(profile.gates.find((g) => g.name === 'Largest single domain')?.met).toBe(false);
  });

  it('counts academic sources toward the official floor', () => {
    // A technical question can be well-evidenced without a single regulator.
    const sources = [
      ...many('arxiv.org', 6),
      ...many('example.io', 6),
      ...many('other.io', 2),
    ];
    const profile = profileEvidence(sources);
    expect(profile.officialShare).toBeGreaterThanOrEqual(0.3);
    expect(profile.gates.find((g) => g.name === 'Official or academic share')?.met).toBe(true);
  });

  it('applies the lighter floors when asked', () => {
    const sources = [...many('a.gov', 2), ...many('b.io', 4), ...many('c.io', 1)];
    expect(profileEvidence(sources, 'standard').gates.find((g) => g.name === 'Sources used')?.met).toBe(false);
    expect(profileEvidence(sources, 'light').gates.find((g) => g.name === 'Sources used')?.met).toBe(true);
  });

  it('does not divide by zero on a report that cited nothing', () => {
    const profile = profileEvidence([]);
    expect(profile.officialShare).toBe(0);
    expect(profile.largestSingleDomainShare).toBe(0);
    expect(() => renderProfile(profile)).not.toThrow();
  });
});

describe('the citation registry is numbered, deduplicated and frozen', () => {
  it('gives one number to one page, however it was spelled', () => {
    const report = [
      'A claim <cite url="https://www.example.com/page/?utm_source=x">1</cite>.',
      'The same page again <cite url="https://example.com/page">2</cite>.',
      'A different one <cite url="https://other.org/b">3</cite>.',
    ].join('\n');
    const registry = buildRegistry(report);
    expect(registry).toHaveLength(2);
    expect(registry[0]?.n).toBe(1);
    expect(registry[1]?.domain).toBe('other.org');
  });

  it('is empty rather than wrong when a report cites nothing', () => {
    expect(buildRegistry('# A report with no citations at all')).toEqual([]);
  });
});

describe('the search trace records what was asked, not a promise to repeat it', () => {
  it('separates enforced filters from requested ones and says re-running may differ', () => {
    const rendered = renderTrace({
      provider: 'perplexity',
      tier: 'fast',
      shape: 'recent',
      window: '90d',
      enforced: ['recency filter: year'],
      requested: ['only use sources published within the last 90d'],
      asOf: '2026-07-25T00:00:00.000Z',
      urls: ['https://a.com/1'],
    });
    expect(rendered).toMatch(/Enforced by the backend: recency filter: year/);
    expect(rendered).toMatch(/prompt only: only use sources published within the last 90d/);
    expect(rendered).toMatch(/not guaranteed to reproduce/);
  });
});

describe('a model saying "no source" is not a source', () => {
  it('refuses to count unknown, N/A and prose as independent domains', () => {
    // Three admissions that there was no source used to become three distinct
    // "domains" and graded the claim `corroborated`.
    const v = assessSupport([
      { provider: 'a', text: 'Revenue grew 12%', urls: ['unknown'] },
      { provider: 'b', text: 'Revenue grew 12%', urls: ['N/A'] },
      { provider: 'c', text: 'Revenue grew 12%', urls: ['source unavailable'] },
    ]);
    expect(v.independentDomains).toBe(0);
    expect(v.support).toBe('unsupported');
  });

  it('still counts real URLs beside the noise', () => {
    const v = assessSupport([
      { provider: 'a', text: 'x', urls: ['unknown', 'https://a.com/1'] },
      { provider: 'b', text: 'x', urls: ['https://b.org/2'] },
    ]);
    expect(v.independentDomains).toBe(2);
  });
});

describe('EVID-15: a source dated after the as-of date is caught however close it is', () => {
  // `Math.round(-0.4)` is `-0` and `-0 < 0` is false, so the guard compared a
  // rounded day count and missed everything inside twelve hours. Found by
  // BENCH-06 building the benchmark's own copy of this rule.
  it.each([1, 3, 6, 11, 23, 48])('catches a source %i hour(s) after the horizon', (hours) => {
    const asOf = '2026-07-27T00:00:00Z';
    const published = new Date(Date.parse(asOf) + hours * 3600_000).toISOString();
    const result = assessStaleness(published, asOf, 'official');
    expect(result.freshness, `${String(hours)}h after the horizon`).toBe('after-horizon');
  });

  it('still treats a source on the horizon itself as current, not future', () => {
    const asOf = '2026-07-27T00:00:00Z';
    const result = assessStaleness(asOf, asOf, 'official');
    expect(result.freshness).not.toBe('after-horizon');
  });
});
