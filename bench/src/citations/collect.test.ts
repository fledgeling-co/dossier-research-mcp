import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiskRegistryCache, MemoryRegistryCache } from './cache.js';
import { citationLookupCoordinator, collectAnchors, collectCitationEvidence } from './collect.js';
import { parseEvidence } from './evidence.js';
import type { RegistryResponse } from './registries.js';
import { BlockedUrlError } from '../../../src/net/safe-fetch.js';
import type { FetchedPage } from './fetch.js';

/**
 * Collection, entirely offline.
 *
 * Every transport here is a function returning a literal, which is the point of
 * the injected boundary: the collector's whole decision surface is exercised in
 * the gate with no network, no waiting and no key. The one test that matters
 * most is the last: with every call failing, a full snapshot still comes back,
 * because a collection that gives up halfway leaves a scorer computing a rate
 * over whichever half happened to succeed.
 */

const page = (over: Partial<FetchedPage> = {}): FetchedPage => ({
  url: 'https://example.com/a',
  status: 200,
  ok: true,
  body: '<html><body><p id="results">Adoption reached 28.6%.</p></body></html>',
  contentType: '',
  truncated: false,
  ...over,
});

function transportFor(map: Record<string, RegistryResponse>): (url: string) => Promise<RegistryResponse> {
  return (url) => {
    for (const [fragment, response] of Object.entries(map)) {
      if (url.includes(fragment)) return Promise.resolve(response);
    }
    return Promise.resolve({ status: 0, body: '', error: 'no scripted response' });
  };
}

const REPORT = 'Adoption reached 28.6% [source](https://example.com/a), see 10.1038/nature12373.';

describe('anchors', () => {
  it('collects id and name attributes and decodes their entities', () => {
    const found = collectAnchors('<a name="top"></a><div id="a&amp;b"></div><p id=bare>');
    expect(found).toContain('top');
    expect(found).toContain('a&b');
    expect(found).toContain('bare');
  });

  it('returns nothing for a document with no anchors', () => {
    expect(collectAnchors('<p>plain</p>')).toEqual([]);
  });

  it('does not read data-id, a commented-out attribute or a string inside a script', () => {
    // A browser resolves a fragment against `id` and `name` and nothing else, so
    // reading these would report a page as declaring anchors it does not have,
    // which turns a real broken fragment into an honest one.
    const found = collectAnchors(
      '<div data-id="ghost"></div><!-- id="comment" --><script>var a = \'name="fake"\';</script><style>#x{}</style><p id="real"></p>',
    );
    expect(found).toEqual(['real']);
  });
});

describe('a snapshot of one report', () => {
  it('records the page, the identifier and the report hash', async () => {
    const evidence = await collectCitationEvidence(REPORT, {
      registryTransport: transportFor({ 'api.crossref.org': { status: 200, body: '{}' } }),
      fetchPage: () => Promise.resolve(page()),
    });
    expect(evidence.pages).toHaveLength(1);
    expect(evidence.pages[0]).toMatchObject({ verdict: 'live', truncated: false, completeHtml: true });
    expect(evidence.pages[0]?.anchors).toContain('results');
    expect(evidence.registry).toHaveLength(1);
    expect(evidence.registry[0]).toMatchObject({ kind: 'doi', status: 'present', via: 'crossref' });
    expect(evidence.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    // It is its own schema's citizen, so a scorer can read it back from disk.
    expect(() => parseEvidence(evidence)).not.toThrow();
  });

  it('escalates a Crossref miss to the handle directory (INTEG-03)', async () => {
    const evidence = await collectCitationEvidence('See 10.5281/zenodo.3509134 for the data.', {
      registryTransport: transportFor({
        'api.crossref.org': { status: 404, body: '{}' },
        'doi.org/api/handles': { status: 200, body: '{"responseCode":1}' },
      }),
      fetchPage: () => Promise.resolve(page()),
    });
    expect(evidence.registry[0]).toMatchObject({ status: 'present', via: 'doi-handle' });
  });

  it('carries a truncated body through as truncated (INTEG-41)', async () => {
    const evidence = await collectCitationEvidence(REPORT, {
      registryTransport: transportFor({}),
      fetchPage: () => Promise.resolve(page({ truncated: true })),
    });
    expect(evidence.pages[0]?.truncated).toBe(true);
    // A truncated body is never complete readable HTML, so anchors are not
    // listed from it and the anchor check answers unchecked rather than missing.
    expect(evidence.pages[0]?.completeHtml).toBe(false);
  });

  it('keeps a refused URL\'s own verdict instead of flattening it to unreachable', async () => {
    const blocked = new BlockedUrlError('private', 'Private address blocked: 127.0.0.1');
    const evidence = await collectCitationEvidence(REPORT, {
      registryTransport: transportFor({}),
      fetchPage: () =>
        Promise.resolve(
          page({ ok: false, status: 0, body: '', error: blocked.message, thrown: blocked }),
        ),
    });
    // The product calls an SSRF refusal `invalid_url` and a timeout
    // `unreachable`, and those are different findings about a citation.
    expect(evidence.pages[0]?.verdict).toBe('invalid_url');
  });

  it('calls a self-redirect loop blocked, not invalid, as the product does', async () => {
    const loop = new BlockedUrlError('redirect_loop', 'Server redirects this URL to itself');
    const evidence = await collectCitationEvidence(REPORT, {
      registryTransport: transportFor({}),
      fetchPage: () =>
        Promise.resolve(page({ ok: false, status: 0, body: '', error: loop.message, thrown: loop })),
    });
    expect(evidence.pages[0]?.verdict).toBe('blocked');
  });

  it('records a page that would not load, rather than dropping it', async () => {
    const evidence = await collectCitationEvidence(REPORT, {
      registryTransport: transportFor({}),
      fetchPage: () =>
        Promise.resolve(page({ ok: false, status: 0, body: '', error: 'connect ETIMEDOUT' })),
    });
    expect(evidence.pages[0]).toMatchObject({ verdict: 'unreachable' });
  });
});

describe('the cache (INTEG-06, INTEG-07)', () => {
  it('looks one identifier up once across many reports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cite-collect-'));
    const cache = new DiskRegistryCache(dir);
    let calls = 0;
    const options = {
      registryTransport: (url: string) => {
        calls += 1;
        return Promise.resolve(
          url.includes('crossref') ? { status: 200, body: '{}' } : { status: 404, body: '{}' },
        );
      },
      fetchPage: () => Promise.resolve(page()),
      cache,
    };
    await collectCitationEvidence(REPORT, options);
    await collectCitationEvidence(`Another report, same DOI 10.1038/nature12373.`, options);
    expect(calls).toBe(1);
  });

  it('collapses two concurrent collections onto one lookup, given a shared coordinator', async () => {
    let calls = 0;
    const shared = citationLookupCoordinator({ cache: new MemoryRegistryCache() });
    const options = {
      registryTransport: () => {
        calls += 1;
        return new Promise<RegistryResponse>((resolve) => {
          setTimeout(() => {
            resolve({ status: 200, body: '{}' });
          }, 5);
        });
      },
      fetchPage: () => Promise.resolve(page()),
      ...shared,
    };
    await Promise.all([
      collectCitationEvidence(REPORT, options),
      collectCitationEvidence(REPORT, options),
    ]);
    expect(calls).toBe(1);
  });

  it('does not remember an unchecked answer', async () => {
    const cache = new MemoryRegistryCache();
    let calls = 0;
    const options = {
      registryTransport: () => {
        calls += 1;
        return Promise.resolve({ status: 429, body: 'Rate exceeded.' });
      },
      fetchPage: () => Promise.resolve(page()),
      cache,
    };
    await collectCitationEvidence(REPORT, options);
    await collectCitationEvidence(REPORT, options);
    // Two lookups, because the first was never an answer worth keeping.
    expect(calls).toBe(4);
    expect(cache.get('doi', '10.1038/nature12373')).toBeUndefined();
  });
});

describe('with nothing reachable at all (INTEG-40)', () => {
  it('still returns a complete snapshot in which nothing is absent', async () => {
    const evidence = await collectCitationEvidence(REPORT, {
      registryTransport: () =>
        Promise.resolve({ status: 0, body: '', error: 'getaddrinfo ENOTFOUND' }),
      fetchPage: () =>
        Promise.resolve(page({ ok: false, status: 0, body: '', error: 'getaddrinfo ENOTFOUND' })),
    });
    expect(evidence.pages).toHaveLength(1);
    expect(evidence.registry).toHaveLength(1);
    expect(evidence.registry[0]?.status).toBe('unchecked');
    expect(evidence.registry.every((r) => r.status !== 'absent')).toBe(true);
    expect(() => parseEvidence(evidence)).not.toThrow();
  });
});

describe('caps', () => {
  it('names what it did not reach, so silence is never mistaken for success', async () => {
    const many = Array.from(
      { length: 5 },
      (_, i) => `Claim ${String(i)} [s](https://example.com/${String(i)}).`,
    ).join(' ');
    const evidence = await collectCitationEvidence(many, {
      registryTransport: transportFor({}),
      fetchPage: () => Promise.resolve(page()),
      maxPages: 2,
    });
    expect(evidence.pages).toHaveLength(2);
    expect(evidence.notes.join(' ')).toMatch(/unchecked rather than absent/);
  });
});

describe('DATE-18 the collector dates the page it already holds', () => {
  const options = {
    registryTransport: transportFor({}),
    now: () => new Date('2026-07-28T00:00:00.000Z'),
  };

  it('persists the date, the signal and the raw string on the page evidence', async () => {
    const evidence = await collectCitationEvidence('See [a](https://example.com/a).', {
      ...options,
      fetchPage: () =>
        Promise.resolve(
          page({
            body: '<html><head><meta name="citation_date" content="2025/09/02"></head><body>x</body></html>',
          }),
        ),
    });
    const first = evidence.pages[0];
    expect(first?.published).toEqual({
      status: 'found',
      date: '2025-09-02',
      signal: 'citation-meta',
      raw: '2025/09/02',
      detail: 'read from the `citation_date` meta tag',
    });
  });

  it('records an explicit absence for a page that carries no date', async () => {
    const evidence = await collectCitationEvidence('See [a](https://example.com/a).', {
      ...options,
      fetchPage: () => Promise.resolve(page()),
    });
    expect(evidence.pages[0]?.published.status).toBe('absent');
  });

  it('does not let a 404 page\'s own furniture date the citation', async () => {
    // Gated on the judged verdict, exactly as `containment` is: a page that did
    // not resolve is nowhere to look, and an error template carrying today's
    // date would otherwise grade a dead citation as freshly published.
    const evidence = await collectCitationEvidence('See [a](https://example.com/a).', {
      ...options,
      fetchPage: () =>
        Promise.resolve(
          page({
            status: 404,
            ok: false,
            body: '<html><head><meta name="citation_date" content="2026-07-27"></head></html>',
          }),
        ),
    });
    expect(evidence.pages[0]?.verdict).toBe('not_found');
    expect(evidence.pages[0]?.published.status).toBe('unchecked');
  });

  it('reads the raw body rather than the extracted text, which strips the markup', async () => {
    // `extractText` removes every tag, so a date living in a meta attribute or a
    // JSON-LD script body is gone by the time the text is produced. Reading the
    // extracted text instead would silently date nothing at all.
    const evidence = await collectCitationEvidence('See [a](https://example.com/a).', {
      ...options,
      fetchPage: () =>
        Promise.resolve(
          page({
            body: '<html><head><script type="application/ld+json">{"@type":"Article","datePublished":"2024-03-15"}</script></head><body>no visible date</body></html>',
          }),
        ),
    });
    expect(evidence.pages[0]?.text).not.toContain('2024-03-15');
    expect(evidence.pages[0]?.published).toMatchObject({ status: 'found', date: '2024-03-15' });
  });

  it('survives a fetch that threw, recording unchecked rather than losing the page', async () => {
    const evidence = await collectCitationEvidence('See [a](https://example.com/a).', {
      ...options,
      fetchPage: () => Promise.reject(new BlockedUrlError('private', 'refused as a private address')),
    });
    expect(evidence.pages[0]?.published.status).toBe('unchecked');
  });
});
