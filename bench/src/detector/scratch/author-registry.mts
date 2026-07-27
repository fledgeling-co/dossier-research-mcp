import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../../detector/', import.meta.url).pathname;
const dir = join(root, 'registry');
mkdirSync(dir, { recursive: true });

interface R { status: number; body?: string; error?: string; step?: string }
interface C {
  id: string; kind: string; identifier: string; snippet: string; label: string;
  provenance: 'captured' | 'constructed'; observedAt: string; why: string; responses: R[];
}

const arxivFeed = (total: number, entryId?: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">` +
  `<opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">${String(total)}</opensearch:totalResults>` +
  (entryId === undefined ? '' : `<entry><id>${entryId}</id><title>A paper</title></entry>`) +
  `</feed>`;

const cases: C[] = [
  // ---------- present ----------
  { id: 'registry-doi-crossref-present', kind: 'doi', identifier: '10.1145/3442188.3445922',
    snippet: 'Bender and colleagues set out the argument in 10.1145/3442188.3445922, which the report cites directly.',
    label: 'present', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'Crossref answers 200 on the first step, which the rule reads as present without needing the handle directory at all. The easy direction, included so the corpus can tell a detector that is cautious from one that never says present.',
    responses: [{ status: 200, body: '{"status":"ok"}', step: 'crossref' }] },
  { id: 'registry-doi-handle-rescues', kind: 'doi', identifier: '10.5281/zenodo.3509134',
    snippet: 'The dataset is archived at 10.5281/zenodo.3509134 and the figures are drawn from it.',
    label: 'present', provenance: 'captured', observedAt: '2026-07-27',
    why: 'BENCH-03 probed this DOI live on 27 July 2026: Crossref answers 404 and the global handle directory answers 200, because Zenodo registers through DataCite rather than Crossref. It is the single most important case in this family. A detector that stopped at Crossref would report a real, live, citable dataset as a fabricated reference, which is the benchmark becoming the thing it exists to detect.',
    responses: [{ status: 404, body: '{"status":"error"}', step: 'crossref' }, { status: 200, body: '{"responseCode":1,"handle":"10.5281/zenodo.3509134"}', step: 'doi-handle' }] },
  { id: 'registry-cve-present', kind: 'cve', identifier: 'CVE-2021-44228',
    snippet: 'The report attributes the incident to CVE-2021-44228 and links the NVD record.',
    label: 'present', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'The NVD answers 200 with totalResults 1. The status alone decides nothing here, which is why the case scripts a body: BENCH-03 verified on 27 July 2026 that an unknown CVE also answers 200, with totalResults 0.',
    responses: [{ status: 200, body: '{"resultsPerPage":1,"totalResults":1,"vulnerabilities":[{"cve":{"id":"CVE-2021-44228"}}]}', step: 'nvd' }] },
  { id: 'registry-isbn-catalogue-present', kind: 'isbn', identifier: '9780262033848',
    snippet: 'The textbook is ISBN: 9780262033848 and the chapter reference points at it.',
    label: 'present', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'OpenLibrary answers 200 with the bibkey present, which the rule reads as catalogue presence. The label is present because that is the verdict the detector should reach; what present may be taken to mean is narrower than the word suggests, and the detail on the answer says so in both directions.',
    responses: [{ status: 200, body: '{"ISBN:9780262033848":{"info_url":"https://openlibrary.org/books/OL25718398M"}}', step: 'openlibrary' }] },

  { id: 'registry-arxiv-entry-matches', kind: 'arxiv', identifier: '2509.04499',
    snippet: 'The metric algebra is set out in arxiv.org/abs/2509.04499, which the report leans on throughout.',
    label: 'present', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'A feed reporting one result whose entry id is the identifier that was asked about, which is the positive counterpart to the feed that names another paper. Both are needed: a rule that requires the entry id would be untested in the direction that matters if the corpus only carried the failing case.',
    responses: [{ status: 200, body: arxivFeed(1, 'http://arxiv.org/abs/2509.04499v1'), step: 'arxiv' }] },

  // ---------- absent ----------
  { id: 'registry-doi-fabricated', kind: 'doi', identifier: '10.9999/nonexistent.2026.0001',
    snippet: 'The claim is sourced to 10.9999/nonexistent.2026.0001, which the report gives as a journal article.',
    label: 'absent', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'Crossref 404 and then the global handle directory answering 404 with responseCode 100, its own not-found code. Only the second of those decides anything, and requiring the code rather than the status means a proxy error page, which is also a 404, cannot be read as a fabricated reference.',
    responses: [{ status: 404, body: '{"status":"error"}', step: 'crossref' }, { status: 404, body: '{"responseCode":100,"handle":"10.9999/nonexistent.2026.0001"}', step: 'doi-handle' }] },
  { id: 'registry-pmid-fabricated', kind: 'pmid', identifier: '99999999',
    snippet: 'The trial is cited as PMID: 99999999 in the evidence table.',
    label: 'absent', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'NCBI answers HTTP 200 carrying an error on the entry, which BENCH-03 verified live on 27 July 2026. Reading the status alone would score every fabricated PMID as real, so the case scripts the exact body shape that decides it.',
    responses: [{ status: 200, body: '{"header":{"type":"esummary"},"result":{"uids":["99999999"],"99999999":{"uid":"99999999","error":"cannot get document summary"}}}', step: 'ncbi' }] },
  { id: 'registry-cve-fabricated', kind: 'cve', identifier: 'CVE-2026-0001',
    snippet: 'The advisory is given as CVE-2026-0001 with no link.',
    label: 'absent', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'The NVD answers 200 with totalResults 0. Same trap as the PMID and the same reason for scripting the body: a 200 here means the query ran, not that the identifier exists.',
    responses: [{ status: 200, body: '{"resultsPerPage":0,"totalResults":0,"vulnerabilities":[]}', step: 'nvd' }] },
  { id: 'registry-isbn-catalogue-absent', kind: 'isbn', identifier: '9786060606062',
    snippet: 'The monograph is listed as ISBN: 9786060606062 in the bibliography.',
    label: 'absent', provenance: 'captured', observedAt: '2026-07-27',
    why: 'BENCH-03 probed this number live on 27 July 2026 and OpenLibrary returned an empty object. The label is absent because that is the verdict the rule reaches and should reach. What it cannot mean is that the book does not exist: the same probe found that the fabricated 9789999999991 resolves to a real catalogue record, so the catalogue is evidence in neither direction and the answer says so.',
    responses: [{ status: 200, body: '{}', step: 'openlibrary' }] },

  // ---------- unchecked ----------
  { id: 'registry-arxiv-rate-limited', kind: 'arxiv', identifier: '2509.04499',
    snippet: 'The audit framework is described in arXiv:2509.04499, which the report cites for its metric definitions.',
    label: 'unchecked', provenance: 'captured', observedAt: '2026-07-27',
    why: 'BENCH-03 probed arXiv live on 27 July 2026 and every request across a seven-minute span answered 429 Rate exceeded, after only a handful of calls. This paper is real, live and exactly what the identifier says it is, so unchecked is the only honest answer and absent would be a fabricated accusation produced entirely by somebody else being busy. For this archive unchecked is the ordinary answer rather than the rare one.',
    responses: [{ status: 429, body: 'Rate exceeded', step: 'arxiv' }] },
  { id: 'registry-doi-handle-server-error', kind: 'doi', identifier: '10.1038/s41586-021-03819-2',
    snippet: 'The structure prediction result is 10.1038/s41586-021-03819-2 in the reference list.',
    label: 'unchecked', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'Crossref answers 503 and the handle directory answers 500. Neither step said anything about the identifier, so nothing is known about it. This DOI is a real and very well known paper, which is the point: an outage must not be able to convert a genuine reference into an accusation.',
    responses: [{ status: 503, body: 'Service Unavailable', step: 'crossref' }, { status: 500, body: 'Internal Server Error', step: 'doi-handle' }] },
  { id: 'registry-pmid-request-timed-out', kind: 'pmid', identifier: '32015507',
    snippet: 'The cohort study is cited as PMID: 32015507 in the evidence table.',
    label: 'unchecked', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'The transport threw rather than answering. A timeout carries no information about the identifier at all, and the loop must reach unchecked without the response body it never received. This is the failure mode most likely to be mishandled, because a thrown error is the one path that does not go through the interpreter.',
    responses: [{ status: 0, body: '', error: 'the request timed out after 20000ms', step: 'ncbi' }] },
  { id: 'registry-cve-gateway-page', kind: 'cve', identifier: 'CVE-2023-4863',
    snippet: 'The image-decoding flaw is CVE-2023-4863, cited to the NVD.',
    label: 'unchecked', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'The NVD answers 200 with an HTML gateway page instead of its JSON result. A body the parser cannot read is not an answer, and treating an unparseable 200 as totalResults 0 would report a real CVE as fabricated because a load balancer was in the way.',
    responses: [{ status: 200, body: '<html><head><title>503 Service Temporarily Unavailable</title></head><body>The service is unavailable.</body></html>', step: 'nvd' }] },
  { id: 'registry-doi-handle-404-not-its-own-body', kind: 'doi', identifier: '10.5555/proxy-error-example',
    snippet: 'The working paper is 10.5555/proxy-error-example in the reference list.',
    label: 'unchecked', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'Crossref 404, then a handle-directory 404 whose body is an HTML error page rather than the directory answering responseCode 100. The status matches the absent path and the body does not, and the rule requires both. A proxy or a captive portal returning 404 is exactly the shape that would otherwise manufacture a fabrication verdict.',
    responses: [{ status: 404, body: '{"status":"error"}', step: 'crossref' }, { status: 404, body: '<html><body>404 Not Found</body></html>', step: 'doi-handle' }] },
  { id: 'registry-arxiv-feed-names-another-paper', kind: 'arxiv', identifier: '2411.00640',
    snippet: 'The power analysis is arXiv:2411.00640, cited for the sample-size formula.',
    label: 'unchecked', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'arXiv answers 200 with a feed reporting one result whose entry id is a different paper. A count is not an answer: a feed describing something else says nothing about the identifier that was asked about, and reading totalResults alone would turn any non-empty response into confirmation.',
    responses: [{ status: 200, body: arxivFeed(1, 'http://arxiv.org/abs/2106.09685v2'), step: 'arxiv' }] },

  // ---------- invalid ----------
  { id: 'registry-isbn-check-digit-wrong', kind: 'isbn', identifier: '9780262033849',
    snippet: 'The textbook is given as ISBN: 9780262033849 in the bibliography.',
    label: 'invalid', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'The final digit disagrees with the rest of the number, which the grammar of an ISBN settles without asking anybody. A mistyped digit is a typo and not a fabrication, and sending it to a catalogue that will truthfully say it has never heard of it would read as a fabricated citation. No request is made at all, which is why the case scripts no response.',
    responses: [] },
  { id: 'registry-doi-path-traversal', kind: 'doi', identifier: '10.1234/../../etc/passwd',
    snippet: 'The reference is written 10.1234/../../etc/passwd, which the extractor sees as a DOI.',
    label: 'invalid', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'The identifier came out of a model that was itself reading the open web and is about to be interpolated into a URL path, so it is untrusted input. A DOI has no legitimate reason to carry a traversal segment; it is refused before any URL is built, and refusing is the failure mode that cannot surprise anyone.',
    responses: [] },
  { id: 'registry-doi-single-dot-segment', kind: 'doi', identifier: '10.5555/./secrets',
    snippet: 'The source is cited as 10.5555/./secrets in the footnotes.',
    label: 'invalid', provenance: 'constructed', observedAt: '2026-07-27',
    why: 'A single dot segment normalises away rather than climbing, so it is the quieter half of the same guard and the half a check written against .. alone would miss. Present as its own case because two traversal shapes that share one test are one test.',
    responses: [] },
];

for (const c of cases) {
  const y = (s: string): string => JSON.stringify(s);
  const lines = [
    `id: ${c.id}`,
    `kind: ${c.kind}`,
    `identifier: ${y(c.identifier)}`,
    `reportSnippet: ${y(c.snippet)}`,
    `label: ${c.label}`,
    `provenance: ${c.provenance}`,
    `observedAt: "${c.observedAt}"`,
    `why: ${y(c.why)}`,
    'responses:',
    ...(c.responses.length === 0
      ? ['  []']
      : c.responses.flatMap((r) => [
          `  - status: ${String(r.status)}`,
          `    body: ${y(r.body ?? '')}`,
          ...(r.error === undefined ? [] : [`    error: ${y(r.error)}`]),
          ...(r.step === undefined ? [] : [`    step: ${r.step}`]),
        ])),
    '',
  ];
  writeFileSync(join(dir, `${c.label}-${c.id}.yaml`), lines.join('\n'), 'utf8');
}
console.log(`wrote ${String(cases.length)} registry cases`);
const counts = new Map<string, number>();
for (const c of cases) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
for (const [k, v] of counts) console.log(`  ${k}: ${String(v)} (${(100 * v / cases.length).toFixed(1)}%)`);
