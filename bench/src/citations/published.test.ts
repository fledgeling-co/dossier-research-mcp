import { describe, expect, it } from 'vitest';
import {
  EARLIEST_URL_YEAR,
  extractPublicationDate,
  plausibleRange,
  readMetaTags,
  readPublicationDate,
  type PublicationDate,
  type PublicationFound,
} from './published.js';

/**
 * The extractor, against the shapes a real page actually carries.
 *
 * Every fixture below is modelled on something the 28 July 2026 probe found on
 * the benchmark's own corpus rather than invented: arXiv's slash-form
 * `citation_date`, bentley.com's `article:published_time` beside its
 * `article:modified_time`, Oracle's `Updated Date`, Intel's `lastModifieddate`,
 * kb.cert.org's `sei_date_published`, Cisco's `1/31/2022 9:16:10 PM`, and the
 * `/2021/12/11/` in an MSRC blog path.
 *
 * The single most important group is the last: three states, not two. A page
 * nobody could read must never be reported as a publisher who omitted a date.
 */

const CHECKED = '2026-07-28T12:00:00.000Z';

function extract(over: {
  readonly url?: string;
  readonly body?: string;
  readonly bodyRead?: boolean;
  readonly truncated?: boolean;
} = {}): PublicationDate {
  return extractPublicationDate({
    url: over.url ?? 'https://example.test/article',
    body: over.body ?? '<html><head></head><body>nothing</body></html>',
    checkedAt: CHECKED,
    bodyRead: over.bodyRead ?? true,
    truncated: over.truncated ?? false,
  });
}

function expectFound(result: PublicationDate): PublicationFound {
  expect(result.status).toBe('found');
  if (result.status !== 'found') throw new Error('expected a found date');
  return result;
}

describe('DATE-01 JSON-LD is the first signal, and it reads datePublished only', () => {
  it('dates a page from a schema.org datePublished and names the signal', () => {
    const body = `<html><head><script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Article","datePublished":"2024-03-15T10:00:00Z","dateModified":"2026-07-01"}
    </script></head><body></body></html>`;
    const found = expectFound(extract({ body }));
    expect(found.date).toBe('2024-03-15');
    expect(found.signal).toBe('json-ld');
    expect(found.raw).toContain('2024-03-15');
    expect(found.detail).toMatch(/datePublished/);
  });

  it('finds one nested inside an @graph, which is how most sites emit it', () => {
    const body = `<html><head><script type="application/ld+json">
      {"@graph":[{"@type":"WebSite"},{"@type":"Article","datePublished":"2023-01-09"}]}
    </script></head></html>`;
    expect(expectFound(extract({ body })).date).toBe('2023-01-09');
  });

  it('does NOT take dateModified, dateCreated or uploadDate', () => {
    // The probe found `dateModified` outnumbering `datePublished` four to one.
    // A walker that took anything date-shaped would mostly take the wrong one.
    const body = `<html><head><script type="application/ld+json">
      {"@type":"Article","dateModified":"2026-07-01","dateCreated":"2020-01-01","uploadDate":"2021-05-05"}
    </script></head></html>`;
    expect(extract({ body }).status).toBe('absent');
  });
});

describe('DATE-02 the academic web dates itself with citation meta', () => {
  it('reads arXiv\'s own slash form', () => {
    const body = `<html><head>
      <meta name="citation_title" content="Something">
      <meta name="citation_date" content="2025/09/02">
      <meta name="citation_online_date" content="2025/09/02">
    </head></html>`;
    const found = expectFound(extract({ body }));
    expect(found.date).toBe('2025-09-02');
    expect(found.signal).toBe('citation-meta');
    expect(found.detail).toMatch(/citation_date/);
  });

  it('prefers citation_publication_date over the other two', () => {
    const body = `<html><head>
      <meta name="citation_online_date" content="2025-09-02">
      <meta name="citation_publication_date" content="2025-06-01">
    </head></html>`;
    expect(expectFound(extract({ body })).date).toBe('2025-06-01');
  });
});

describe('DATE-03 a published time wins over a modified time sitting beside it', () => {
  it('takes article:published_time and leaves article:modified_time alone', () => {
    // bentley.com, verbatim in shape: both properties, minutes apart in the
    // markup, a year apart in meaning.
    const body = `<html><head>
      <meta property="article:published_time" content="2025-05-14T08:17:15+00:00">
      <meta property="article:modified_time" content="2026-07-20T11:00:00+00:00">
    </head></html>`;
    const found = expectFound(extract({ body }));
    expect(found.date).toBe('2025-05-14');
    expect(found.signal).toBe('article-published-time');
  });
});

describe('DATE-04 a modification date is refused before its value is read', () => {
  it.each([
    ['Updated Date', '2021-12-10T23:54:59Z'],
    ['lastModifieddate', '2022-01-12T18:26:48.682Z'],
    ['og:updated_time', '2026-01-01'],
    ['dcterms.modified', '2026-01-01'],
    ['article:modified_time', '2026-01-01'],
  ])('refuses %s and never records it as a publication date', (name, content) => {
    const result = extract({ body: `<html><head><meta name="${name}" content="${content}"></head></html>` });
    expect(result.status).toBe('absent');
    if (result.status === 'found') throw new Error('a modification date was recorded as published');
    expect(result.detail).toMatch(/modification date is not a publication date/);
  });

  it('names the refusal rather than dropping it, so "we saw one" is distinguishable', () => {
    const withOne = extract({
      body: '<html><head><meta name="dateModified" content="2026-01-01"></head></html>',
    });
    const withNothing = extract({ body: '<html><head></head></html>' });
    expect(withOne.detail).not.toBe(withNothing.detail);
    expect(withNothing.detail).not.toMatch(/modification date/);
  });
});

describe('DATE-05 a name that says publish is accepted; one that says public is not', () => {
  it('accepts a site-specific name no allowlist would hold', () => {
    // kb.cert.org answers `sei_date_published`. An allowlist cannot anticipate
    // every publisher's spelling, and this is what generalises.
    const body = '<html><head><meta name="sei_date_published" content="2021-12-15"></head></html>';
    const found = expectFound(extract({ body }));
    expect(found.date).toBe('2021-12-15');
    expect(found.signal).toBe('meta-date');
    expect(found.detail).toMatch(/sei_date_published/);
  });

  it('does not treat GitHub\'s `_public` analytics tag as a publication date', () => {
    const body =
      '<html><head><meta name="octolytics-dimension-repository_public" content="true"></head></html>';
    expect(extract({ body }).status).toBe('absent');
  });

  it('takes the bare `date` meta last, and reads Cisco\'s form', () => {
    const body = '<html><head><meta name="date" content="1/31/2022 9:16:10 PM"></head></html>';
    const found = expectFound(extract({ body }));
    expect(found.date).toBe('2022-01-31');
    expect(found.signal).toBe('meta-date');
  });
});

describe('DATE-06 a <time> element proves nothing unless it says what it is', () => {
  it('refuses a bare <time> and says it may be a comment timestamp', () => {
    const body = '<html><body><time datetime="2019-01-01">a while ago</time></body></html>';
    const result = extract({ body });
    expect(result.status).toBe('absent');
    expect(result.detail).toMatch(/comment timestamp/);
  });

  it.each([
    ['<time datetime="2024-02-02" pubdate>x</time>'],
    ['<time datetime="2024-02-02" itemprop="datePublished">x</time>'],
    ['<time class="entry-date published" datetime="2024-02-02">x</time>'],
  ])('accepts one that declares itself: %s', (tag) => {
    const found = expectFound(extract({ body: `<html><body>${tag}</body></html>` }));
    expect(found.date).toBe('2024-02-02');
    expect(found.signal).toBe('time-element');
  });

  it('skips an undeclared <time> and still reads a declared one further down', () => {
    const body = `<html><body>
      <time datetime="2010-01-01">reading time</time>
      <time datetime="2024-02-02" pubdate>published</time>
    </body></html>`;
    expect(expectFound(extract({ body })).date).toBe('2024-02-02');
  });
});

describe('DATE-07 a year in a path is not a date unless a month is next to it', () => {
  it('dates a blog post from its own address', () => {
    const found = expectFound(
      extract({ url: 'https://msrc-blog.example.test/2021/12/11/some-response/' }),
    );
    expect(found.date).toBe('2021-12-11');
    expect(found.signal).toBe('url-path');
  });

  it('reads a year and month with no day as the first of that month, and says so', () => {
    const found = expectFound(extract({ url: 'https://example.test/2021/12/a-post.html' }));
    expect(found.date).toBe('2021-12-01');
    expect(found.detail).toMatch(/no day stated/);
  });

  it('reads a hyphenated date inside a slug', () => {
    expect(expectFound(extract({ url: 'https://example.test/posts/2024-03-15-launch' })).date).toBe(
      '2024-03-15',
    );
  });

  it('refuses a lone four-digit segment, which is an issue number far more often', () => {
    for (const url of [
      'https://example.test/issues/2019',
      'https://example.test/v/2019/',
      'https://example.test/2019',
    ]) {
      expect(extract({ url }).status).toBe('absent');
    }
  });

  it(`refuses a path year before ${String(EARLIEST_URL_YEAR)}`, () => {
    const result = extract({ url: 'https://example.test/1970/01/thing' });
    expect(result.status).toBe('absent');
    expect(result.detail).toMatch(/identifier/);
  });
});

describe('DATE-08 an undecidable field order is refused rather than guessed', () => {
  const bounds = plausibleRange(CHECKED);

  it('refuses 1/5/2022, which is two different days', () => {
    const reading = readPublicationDate('1/5/2022', bounds);
    expect(reading.date).toBeNull();
    expect(reading.why).toMatch(/field order cannot be determined/);
  });

  it('accepts 1/31/2022, because 31 cannot be a month', () => {
    expect(readPublicationDate('1/31/2022', bounds).date).toBe('2022-01-31');
  });
});

describe('DATE-09 an implausible date is a misread, not a publication date', () => {
  const bounds = plausibleRange(CHECKED);

  it('refuses a date later than the page was fetched', () => {
    const reading = readPublicationDate('2030-01-01', bounds);
    expect(reading.date).toBeNull();
    expect(reading.why).toMatch(/later than the page was fetched/);
  });

  it('refuses a date before 1900', () => {
    expect(readPublicationDate('1834-06-01', bounds).date).toBeNull();
  });

  it('allows a genuinely old source, so an ancient citation is stale rather than undated', () => {
    expect(readPublicationDate('1954-06-07', bounds).date).toBe('1954-06-07');
  });

  it('refuses an unreadable fetch time rather than widening the window to everything', () => {
    expect(() => plausibleRange('not a time')).toThrow(/readable fetch time/);
  });
});

describe('DATE-10 the more explicit signal decides, and the result says which', () => {
  it('takes JSON-LD over a URL path that disagrees', () => {
    const body = `<html><head><script type="application/ld+json">
      {"@type":"Article","datePublished":"2024-03-15"}
    </script></head></html>`;
    const found = expectFound(extract({ body, url: 'https://example.test/2019/01/old-slug' }));
    expect(found.date).toBe('2024-03-15');
    expect(found.signal).toBe('json-ld');
  });

  it('takes citation meta over a bare `date` meta that disagrees', () => {
    const body = `<html><head>
      <meta name="date" content="2019-01-01">
      <meta name="citation_date" content="2024-03-15">
    </head></html>`;
    expect(expectFound(extract({ body })).signal).toBe('citation-meta');
  });

  it('falls back to the URL path only when the body gave nothing', () => {
    expect(
      expectFound(extract({ url: 'https://example.test/2019/01/old-slug' })).signal,
    ).toBe('url-path');
  });
});

describe('DATE-11 where one signal carries several dates the earliest wins', () => {
  it('takes the older of two JSON-LD datePublished values', () => {
    const body = `<html><head><script type="application/ld+json">
      [{"@type":"Article","datePublished":"2024-03-15"},{"@type":"Article","datePublished":"2020-01-01"}]
    </script></head></html>`;
    const found = expectFound(extract({ body }));
    // The older reading cannot flatter a source, which is the tie-break this
    // whole slice takes wherever two answers are available.
    expect(found.date).toBe('2020-01-01');
  });

  it('takes the earliest of several dates inside one value, and says it did', () => {
    const reading = readPublicationDate('2024-03-15, revised 2025-01-01', plausibleRange(CHECKED));
    expect(reading.date).toBe('2024-03-15');
    expect(reading.why).toMatch(/earliest/);
  });
});

describe('DATE-12 three states, and the third is the one that matters', () => {
  it('a page nobody could read is unchecked, never absent', () => {
    const result = extract({ body: '', bodyRead: false });
    expect(result.status).toBe('unchecked');
    expect(result.detail).toMatch(/nothing was read from this page/);
  });

  it('a page read in full with no date is absent, and says the page was read', () => {
    const result = extract({ body: '<html><head></head><body>text</body></html>' });
    expect(result.status).toBe('absent');
    expect(result.detail).toMatch(/read in full/);
  });

  it('a page cut short at the byte cap is unchecked, not absent', () => {
    // The distinction the whole project keeps re-learning. A date that sat past
    // the cap was never looked at, and reporting that as a publisher who omitted
    // one is an accusation dressed as a measurement.
    const result = extract({ body: '<html><head></head><body>text', truncated: true });
    expect(result.status).toBe('unchecked');
    expect(result.detail).toMatch(/byte cap/);
  });

  it('a truncated page that DID carry a date is still found', () => {
    const body = '<html><head><meta name="citation_date" content="2024-03-15"></head><body>cut';
    expect(expectFound(extract({ body, truncated: true })).date).toBe('2024-03-15');
  });
});

describe('DATE-13 a page that did not resolve is never dated by its own address', () => {
  // The first design read the path even with no body, on the reasoning that an
  // address survives a failed fetch. Running the real extractor over the real
  // corpus refuted it: the only page dated that way was `example-news.invalid`,
  // a **fabricated** URL from the detector corpus, handed a fresh 2026 date out
  // of its own path. That is the backend under test supplying the evidence it is
  // graded on, and no measurement may take that input.

  it('a fabricated URL with a recent-looking path is unchecked, not freshly published', () => {
    const result = extract({
      url: 'https://example-news.invalid/2026/07/quarterly-figures',
      body: '',
      bodyRead: false,
    });
    expect(result.status).toBe('unchecked');
    expect(result.detail).toMatch(/own claim about a source nobody could reach/);
  });

  it('a page that DID resolve is still dated by its path, which is the common case', () => {
    // 14 of the 43 dates found on the real corpus come from a path on a page
    // that resolved, including every Federal Register document. Something was
    // genuinely served at that address, which is what makes it evidence.
    const found = expectFound(
      extract({
        url: 'https://example.test/2021/12/11/post',
        body: '<html><head></head><body>no date in the markup</body></html>',
      }),
    );
    expect(found.signal).toBe('url-path');
    expect(found.date).toBe('2021-12-11');
  });
});

describe('DATE-14 page text is hostile input and every scan is bounded', () => {
  it('skips an unparseable JSON-LD block and names it rather than throwing', () => {
    const body = '<html><head><script type="application/ld+json">{not json</script></head></html>';
    const result = extract({ body });
    expect(result.status).toBe('absent');
    expect(result.detail).toMatch(/not valid JSON/);
  });

  it('skips an oversized JSON-LD block rather than parsing it', () => {
    const filler = '"x",'.repeat(60_000);
    const body = `<html><head><script type="application/ld+json">[${filler}"y"]</script></head></html>`;
    const result = extract({ body });
    expect(result.status).toBe('absent');
    expect(result.detail).toMatch(/larger than this reader will parse/);
  });

  it('survives a deeply nested JSON-LD document without recursing forever', () => {
    let node = '{"datePublished":"2024-03-15"}';
    for (let i = 0; i < 500; i += 1) node = `{"a":${node}}`;
    const body = `<html><head><script type="application/ld+json">${node}</script></head></html>`;
    // Bounded depth means the date past the bound is simply not found, which is
    // the safe direction: an absence, never a crash and never a wrong date.
    expect(() => extract({ body })).not.toThrow();
    expect(extract({ body }).status).toBe('absent');
  });

  it('bounds the meta scan on a page carrying tens of thousands of tags', () => {
    const body = `<html><head>${'<meta name="x" content="y">'.repeat(20_000)}</head></html>`;
    expect(readMetaTags(body).length).toBeLessThanOrEqual(4000);
  });

  it('reads a meta value written with entities, as a browser would', () => {
    const body = '<html><head><meta name="citation_date" content="2024&#x2D;03&#x2D;15"></head></html>';
    expect(expectFound(extract({ body })).date).toBe('2024-03-15');
  });
});

describe('DATE-15 the written forms come from score/dates.ts, not a third parser', () => {
  const bounds = plausibleRange(CHECKED);

  it('reads a written month form, which only that module knows how to accept', () => {
    expect(readPublicationDate('15 March 2024', bounds).date).toBe('2024-03-15');
    expect(readPublicationDate('March 15, 2024', bounds).date).toBe('2024-03-15');
  });

  it('inherits its refusal of a bare year rather than inventing a January guess', () => {
    const reading = readPublicationDate('2019', bounds);
    expect(reading.date).toBeNull();
    expect(reading.why).toMatch(/bare year/);
  });

  it('reads an ISO timestamp as the calendar day the publisher wrote', () => {
    expect(readPublicationDate('2024-03-15T23:30:00-08:00', bounds).date).toBe('2024-03-15');
  });
});
