import { describe, expect, it } from 'vitest';
import { isRefusal, plan, type RegistryResponse, type RegistryStep } from './registries.js';

/**
 * The five registries, read from recorded shapes.
 *
 * Every body below was taken from the live service on 27 July 2026, because
 * three of the five behave differently from what the brief assumed and reading
 * the documentation would have shipped all three defects. The shapes are frozen
 * here so a change at a registry shows up as a failing test rather than as a
 * silently wrong verdict.
 *
 * The rule under test throughout is the fail-closed one: `absent` only where a
 * registry positively said so in a shape this code recognises, and `unchecked`
 * for everything else. Half the assertions here are that something is
 * `unchecked`, and that is the point.
 */

function steps(kind: Parameters<typeof plan>[0], id: string, options = {}): readonly RegistryStep[] {
  const built = plan(kind, id, options);
  if (isRefusal(built)) throw new Error(`expected steps, got a refusal: ${built.detail}`);
  return built.steps;
}

/** Drive a plan against scripted responses, exactly as the collector does. */
function run(
  kind: Parameters<typeof plan>[0],
  id: string,
  responses: readonly RegistryResponse[],
  options = {},
): { status: string; detail: string; via?: string } {
  const built = plan(kind, id, options);
  if (isRefusal(built)) return { status: built.status, detail: built.detail };
  let detail = 'no step concluded';
  for (const [i, step] of built.steps.entries()) {
    const response = responses[i] ?? { status: 0, body: '', error: 'no scripted response' };
    const outcome = step.interpret(response);
    if (outcome.kind === 'next') {
      detail = outcome.detail;
      continue;
    }
    return { status: outcome.kind, detail: outcome.detail, via: step.registry };
  }
  return { status: 'unchecked', detail };
}

const ok = (body: string): RegistryResponse => ({ status: 200, body });

describe('DOI (INTEG-01, INTEG-02, INTEG-03)', () => {
  it('scores present when Crossref holds it, without a second call', () => {
    const result = run('doi', '10.1038/nature12373', [ok('{"status":"ok"}')]);
    expect(result.status).toBe('present');
    expect(result.via).toBe('crossref');
  });

  it('scores present when Crossref does not hold it but the handle directory does', () => {
    // The finding this whole slice turns on. Verified 27 July 2026 against the
    // live services with the real Zenodo DOI 10.5281/zenodo.3509134.
    const result = run('doi', '10.5281/zenodo.3509134', [
      { status: 404, body: '{"status":"error"}' },
      ok('{"responseCode":1,"handle":"10.5281/zenodo.3509134"}'),
    ]);
    expect(result.status).toBe('present');
    expect(result.via).toBe('doi-handle');
  });

  it('scores absent only when the handle directory denies it with its own not-found code', () => {
    const result = run('doi', '10.1038/nature99999999', [
      { status: 404, body: '{"status":"error"}' },
      { status: 404, body: '{"responseCode":100,"handle":"10.1038/nature99999999"}' },
    ]);
    expect(result.status).toBe('absent');
    expect(result.detail).toMatch(/every registration agency/);
  });

  it('does not score absent on a 404 whose body is not the directory answer', () => {
    const result = run('doi', '10.1038/nature99999999', [
      { status: 404, body: '' },
      { status: 404, body: '<html>Not Found</html>' },
    ]);
    expect(result.status).toBe('unchecked');
  });

  it('never lets a Crossref 404 alone decide anything', () => {
    const [crossref] = steps('doi', '10.5281/zenodo.3509134');
    const outcome = crossref?.interpret({ status: 404, body: '' });
    expect(outcome?.kind).toBe('next');
  });
});

describe('the polite pool (INTEG-10)', () => {
  it('carries the contact address when one is configured', () => {
    const [crossref] = steps('doi', '10.1038/nature12373', { crossrefMailto: 'x@example.com' });
    expect(crossref?.url).toContain('mailto=x%40example.com');
  });

  it('omits the parameter entirely when none is configured', () => {
    const [crossref] = steps('doi', '10.1038/nature12373');
    expect(crossref?.url).not.toContain('mailto');
  });
});

describe('transport failures are never evidence (INTEG-04)', () => {
  const failures: readonly RegistryResponse[] = [
    { status: 0, body: '', error: 'connect ETIMEDOUT' },
    { status: 429, body: 'Rate exceeded.' },
    { status: 500, body: 'oops' },
    { status: 503, body: '' },
  ];

  it('scores every one of them unchecked, on every registry', () => {
    for (const failure of failures) {
      expect(run('doi', '10.1038/x', [failure, failure]).status).toBe('unchecked');
      expect(run('arxiv', '2509.04499', [failure]).status).toBe('unchecked');
      expect(run('pmid', '23636398', [failure]).status).toBe('unchecked');
      expect(run('isbn', '9780262033848', [failure]).status).toBe('unchecked');
      expect(run('cve', 'CVE-2021-44228', [failure]).status).toBe('unchecked');
    }
  });

  it('scores an unparseable body unchecked rather than absent', () => {
    expect(run('pmid', '23636398', [ok('<html>maintenance</html>')]).status).toBe('unchecked');
    expect(run('cve', 'CVE-2021-44228', [ok('not json')]).status).toBe('unchecked');
    expect(run('isbn', '9780262033848', [ok('not json')]).status).toBe('unchecked');
    expect(run('arxiv', '2509.04499', [ok('<html>hello</html>')]).status).toBe('unchecked');
  });
});

describe('arXiv (INTEG-14)', () => {
  const feed = (total: number, entryId?: string): string =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults>${String(total)}</opensearch:totalResults>${
      entryId === undefined
        ? ''
        : `<entry><id>http://arxiv.org/abs/${entryId}v1</id><title>A paper</title></entry>`
    }</feed>`;

  it('reads the result count and the entry it names', () => {
    expect(run('arxiv', '2509.04499', [ok(feed(1, '2509.04499'))]).status).toBe('present');
    expect(run('arxiv', '2509.99999', [ok(feed(0))]).status).toBe('absent');
  });

  it('does not read a result describing a different paper as confirmation', () => {
    // A count alone is not the answer: the feed has to carry an entry whose own
    // id is the one that was asked about.
    const result = run('arxiv', '2509.04499', [ok(feed(1, '1234.56789'))]);
    expect(result.status).toBe('unchecked');
    expect(result.detail).toMatch(/no entry with this id/);
  });

  it('scores the 429 the archive actually answers as unchecked', () => {
    // Observed on every attempt across seven minutes on 27 July 2026.
    const result = run('arxiv', '2509.04499', [{ status: 429, body: 'Rate exceeded.' }]);
    expect(result.status).toBe('unchecked');
    expect(result.detail).toContain('429');
  });
});

describe('PMID (INTEG-11)', () => {
  it('is decided by the error key in the body, not by the 200 status', () => {
    const present = ok('{"header":{},"result":{"uids":["23636398"],"23636398":{"uid":"23636398","source":"Nature"}}}');
    const absent = ok('{"header":{},"result":{"uids":["999999999"],"999999999":{"uid":"999999999","error":"cannot get document summary"}}}');
    expect(run('pmid', '23636398', [present]).status).toBe('present');
    expect(run('pmid', '999999999', [absent]).status).toBe('absent');
  });

  it('is unchecked when the summary carries no entry for the id at all', () => {
    expect(run('pmid', '23636398', [ok('{"result":{"uids":[]}}')]).status).toBe('unchecked');
  });
});

describe('CVE (INTEG-12)', () => {
  it('is decided by the result count, not by the 200 status', () => {
    expect(run('cve', 'CVE-2021-44228', [ok('{"totalResults":1,"vulnerabilities":[{}]}')]).status).toBe('present');
    expect(run('cve', 'CVE-2021-99999', [ok('{"totalResults":0,"vulnerabilities":[]}')]).status).toBe('absent');
  });
});

describe('ISBN (INTEG-13)', () => {
  it('labels both directions as catalogue presence, never as the book existing', () => {
    const present = run('isbn', '9780262033848', [ok('{"ISBN:9780262033848":{"bib_key":"ISBN:9780262033848"}}')]);
    expect(present.status).toBe('present');
    expect(present.detail).toMatch(/catalogue presence, not proof the book exists/);

    const absent = run('isbn', '9786060606062', [ok('{}')]);
    expect(absent.status).toBe('absent');
    expect(absent.detail).toMatch(/coverage is incomplete/);
  });

  it('refuses a checksum failure before any request is built', () => {
    const built = plan('isbn', '9780262033847');
    expect(isRefusal(built)).toBe(true);
    expect(run('isbn', '9780262033847', [])).toMatchObject({ status: 'invalid' });
  });
});

describe('URL building (INTEG-16)', () => {
  it('refuses a DOI carrying a traversal segment before building a URL', () => {
    const built = plan('doi', '10.1000/../secret');
    expect(isRefusal(built)).toBe(true);
  });

  it('percent-encodes each path segment while keeping the identifier’s own slashes', () => {
    const [crossref] = steps('doi', '10.1000/a b<c>');
    expect(crossref?.url).toBe('https://api.crossref.org/works/10.1000/a%20b%3Cc%3E');
  });

  it('encodes a query-parameter identifier rather than interpolating it raw', () => {
    // An old-style arXiv id carries a slash, which is the character that would
    // otherwise change the shape of the query it is placed in.
    const [arxiv] = steps('arxiv', 'math.gt/0309136');
    expect(arxiv?.url).toContain('id_list=math.gt%2F0309136');
    const [cve] = steps('cve', 'CVE-2021-44228');
    expect(cve?.url).toContain('cveId=CVE-2021-44228');
  });
});
