import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../../detector/', import.meta.url).pathname;
const dir = join(root, 'support');
mkdirSync(dir, { recursive: true });

interface Page {
  provenance: 'captured' | 'constructed';
  capturedAt: string;
  verdict: string;
  httpStatus: number;
  truncated: boolean;
  completeHtml: boolean;
  textFile: string;
  textSha256: string;
  textChars: number;
  note?: string;
}

const P: Record<string, Page> = {
  rfc6265: { provenance: 'captured', capturedAt: '2026-07-27T09:43:07.721Z', verdict: 'live', httpStatus: 200, truncated: false, completeHtml: false, textFile: 'rfc6265-cookies.txt', textSha256: '19618972e266e7620cf58b9fd4d28bd5ff12b8ab38dc2680d4353f5f1c4cce20', textChars: 79216 },
  semver: { provenance: 'captured', capturedAt: '2026-07-27T09:43:08.163Z', verdict: 'live', httpStatus: 200, truncated: false, completeHtml: true, textFile: 'semver-2-0-0.txt', textSha256: 'fcf9ecf6b360b9c058ef4ca75bff1e19f963298a11e9c16349ecabb6db899abd', textChars: 20120 },
  nvd: { provenance: 'captured', capturedAt: '2026-07-27T09:43:08.195Z', verdict: 'live', httpStatus: 200, truncated: false, completeHtml: true, textFile: 'nvd-cve-2021-44228.txt', textSha256: 'a0f2a506f92a76c45b46f6a8ec484a5d5e5104c47ce7e1286ec50ad858bd4823', textChars: 71190 },
  arxiv: { provenance: 'captured', capturedAt: '2026-07-27T09:43:25.042Z', verdict: 'live', httpStatus: 200, truncated: false, completeHtml: true, textFile: 'arxiv-2509-04499-deeptrace.txt', textSha256: '2604f4c5b88246c60c1b32a3bd4dd789460b66f01cce6144411547da6ffd78bc', textChars: 10508 },
  rfc2119: { provenance: 'captured', capturedAt: '2026-07-27T09:43:25.082Z', verdict: 'live', httpStatus: 200, truncated: false, completeHtml: false, textFile: 'rfc2119-key-words.txt', textSha256: '3c2ceb7bfc84cd34720f4a5271338ab9d8280d34bdd1eb250c64306202f2ed8b', textChars: 4723 },
  mdn: { provenance: 'captured', capturedAt: '2026-07-27T09:43:25.274Z', verdict: 'live', httpStatus: 200, truncated: false, completeHtml: true, textFile: 'mdn-http-404.txt', textSha256: 'dbb65fe7cdcb9fbd19904c9ef86260c2492fafef88bde0a171706becf505b091', textChars: 33521 },
  linkedin: { provenance: 'captured', capturedAt: '2026-07-27T09:43:25.362Z', verdict: 'live', httpStatus: 200, truncated: false, completeHtml: true, textFile: 'linkedin-feed-login-wall.txt', textSha256: '2c2f8fd961310e2556d26f185b95a3b7a68f85db555574e39b19d892953b0361', textChars: 1199, note: 'HTTP 200, a complete HTML document, and a sign-in wall. The whole reason link checking cannot see this class of failure.' },
  x: { provenance: 'captured', capturedAt: '2026-07-27T09:43:26.622Z', verdict: 'live', httpStatus: 200, truncated: false, completeHtml: true, textFile: 'x-home-script-wall.txt', textSha256: '6d760e66f6d51e5d3d70acf41f80ac45150912da6917f0525511b107c5ccd768', textChars: 732, note: 'HTTP 200 carrying a JavaScript-required interstitial. Every word of the timeline it claims to serve is absent.' },
  sciencedirect: { provenance: 'constructed', capturedAt: '2026-07-27', verdict: 'blocked', httpStatus: 403, truncated: false, completeHtml: false, textFile: 'sciencedirect-403.txt', textSha256: '8bc9ad304e29415336aded1ff90fd79698fb2aa8ef3145627ada899c92d6be09', textChars: 947, note: 'Captured from ScienceDirect on 2026-07-27 and edited: the live block page echoes the requesting IP address and a Cloudflare reference number back at the caller, and neither belongs in a committed fixture.' },
  consent: { provenance: 'constructed', capturedAt: '2026-07-27', verdict: 'live', httpStatus: 200, truncated: false, completeHtml: true, textFile: 'consent-wall.txt', textSha256: '3afc760b28329aa193b408750c1e7990e8150e4f558caf3739e8f10bb7107e02', textChars: 681, note: 'A cookie-consent interstitial, written to the shape those pages take rather than frozen from one: a real consent wall differs by region, by cookie jar and by week. HTTP 200 and a complete HTML document carrying no article text.' },
  truncated: { provenance: 'constructed', capturedAt: '2026-07-27', verdict: 'live', httpStatus: 200, truncated: true, completeHtml: false, textFile: 'rfc6265-truncated.txt', textSha256: 'a5e540019d1f4ccc6641ecdd6682c08d710ae65430c3dd225afb70685439d46c', textChars: 4000, note: 'The first 4000 characters of the captured RFC 6265 text, which is what the collector byte cap produces on a long document.' },
};

const URLS: Record<string, string> = {
  rfc6265: 'https://www.rfc-editor.org/rfc/rfc6265.txt',
  semver: 'https://semver.org/',
  nvd: 'https://nvd.nist.gov/vuln/detail/CVE-2021-44228',
  arxiv: 'https://arxiv.org/abs/2509.04499',
  rfc2119: 'https://www.ietf.org/rfc/rfc2119.txt',
  mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404',
  linkedin: 'https://www.linkedin.com/feed/',
  x: 'https://x.com/home',
  sciencedirect: 'https://www.sciencedirect.com/science/article/pii/S0004370223002102',
  consent: 'https://example-news.invalid/2026/07/quarterly-figures',
  truncated: 'https://www.rfc-editor.org/rfc/rfc6265.txt',
};

const TOPICS: Record<string, string> = {
  rfc6265: 'RFC 6265, HTTP state management',
  semver: 'Semantic Versioning 2.0.0',
  nvd: 'CVE-2021-44228 in the NVD',
  arxiv: 'The DeepTRACE abstract page',
  rfc2119: 'RFC 2119, requirement-level key words',
  mdn: 'The MDN reference for HTTP 404',
  linkedin: 'A login wall served with HTTP 200',
  x: 'A script wall served with HTTP 200',
  sciencedirect: 'A publisher block page',
  consent: 'A cookie-consent interstitial',
  truncated: 'RFC 6265, read only as far as the byte cap',
};

interface Case { id: string; page: keyof typeof P; label: string; claim: string; why: string }

const cases: Case[] = [
  // ---------- supports ----------
  { id: 'rfc6265-cookie-count-limits', page: 'rfc6265', label: 'supports',
    claim: 'RFC 6265 asks general-use user agents to store at least 50 cookies per domain and at least 3000 cookies in total.',
    why: 'Section 6.1 of the fetched text says general-use user agents SHOULD provide "At least 50 cookies per domain" and "At least 3000 cookies total". Both figures and the hedging are exactly as the claim states them, so this is the page stating the claim rather than something near it.' },
  { id: 'semver-major-increment', page: 'semver', label: 'supports',
    claim: 'Semantic Versioning 2.0.0 says to increment the MAJOR version when you make incompatible API changes.',
    why: 'The summary at the top of the fetched page reads "MAJOR version when you make incompatible API changes". The claim is that sentence with the subject restored, and nothing is added to it.' },
  { id: 'cve-2021-44228-cvss31-score', page: 'nvd', label: 'supports',
    claim: 'CVE-2021-44228 has a CVSS 3.1 base score of 10.0 and is rated CRITICAL.',
    why: 'The record shows "Score: 10.0 CRITICAL" under CVSS 3.x with the vector CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H. Both the number and the rating are on the page and neither is qualified.' },
  { id: 'deeptrace-eight-dimensions', page: 'arxiv', label: 'supports',
    claim: 'DeepTRACE turns prior community-identified failure cases into eight measurable dimensions spanning answer text, sources, and citations.',
    why: 'The abstract on the fetched page says DeepTRACE "turns prior community-identified failure cases into eight measurable dimensions spanning answer text, sources, and citations". This is the abstract almost verbatim, and is the easy end of the corpus on purpose: a detector that cannot get this right has no business being trusted on the hard cases.' },
  { id: 'rfc2119-bcp-14', page: 'rfc2119', label: 'supports',
    claim: 'RFC 2119 is BCP 14, published in March 1997 by S. Bradner.',
    why: 'The header block reads "Request for Comments: 2119 / S. Bradner / BCP: 14 / March 1997". Every element of the claim is on the page in that block.' },
  { id: 'mdn-410-gone', page: 'mdn', label: 'supports',
    claim: 'The MDN reference says that when a resource is permanently removed a server should send 410 Gone rather than 404.',
    why: 'The page reads "If a resource is permanently removed, servers should send the 410 Gone status instead." The claim restates that with the antecedent of "instead" made explicit, which the surrounding sentence supplies.' },
  { id: 'deeptrace-submitted-date', page: 'arxiv', label: 'supports',
    claim: 'The DeepTRACE paper was submitted to arXiv on 2 September 2025.',
    why: 'The page carries "[Submitted on 2 Sep 2025]". The claim is true of the page and a reader would accept it without hesitation. It is in the corpus because the page abbreviates the month and the claim does not, which is the kind of gap a string-matching detector is expected to fall into and a model is not. Scoring that gap is the point of running both.' },

  // ---------- partially_supports ----------
  { id: 'rfc6265-requires-4096', page: 'rfc6265', label: 'partially_supports',
    claim: 'RFC 6265 requires every user agent to support at least 4096 bytes per cookie.',
    why: 'The page states a weaker version on two counts. It says "General-use user agents SHOULD provide each of the following minimum capabilities", so the level is SHOULD rather than a requirement, and the subject is general-use user agents rather than every user agent. The figure is right and the modality is not, which is precisely what partially_supports is for.' },
  { id: 'semver-leading-zeroes-all', page: 'semver', label: 'partially_supports',
    claim: 'Semantic Versioning 2.0.0 forbids leading zeroes in every identifier in a version string.',
    why: 'The page forbids leading zeroes in two narrower places: the X, Y and Z of a normal version, and numeric pre-release identifiers. Alphanumeric pre-release identifiers and build metadata are not covered by that rule, so "every identifier" is broader than what the page states.' },
  { id: 'semver-build-metadata-same-version', page: 'semver', label: 'partially_supports',
    claim: 'Because build metadata is ignored when determining precedence, Semantic Versioning 2.0.0 treats 1.0.0+001 and 1.0.0+002 as the same version.',
    why: 'The page says build metadata "MUST be ignored when determining version precedence" and that two versions differing only in build metadata "have the same precedence". Equal precedence is not identity, and the specification keeps build metadata as part of the version string, so the claim states something stronger than the page does.' },
  { id: 'cve-2021-44228-2-15-0-rce', page: 'nvd', label: 'partially_supports',
    claim: 'CVE-2021-44228 lets an attacker execute arbitrary code on any server running Apache Log4j2 2.15.0.',
    why: 'The description does place 2.15.0 inside the affected range, so the claim is not simply wrong. It also says "From log4j 2.15.0, this behavior has been disabled by default", which makes unconditional exploitation of a 2.15.0 server a stronger statement than the page supports.' },
  { id: 'deeptrace-judge-agreement', page: 'arxiv', label: 'partially_supports',
    claim: 'DeepTRACE uses an LLM judge whose agreement with human raters was strong.',
    why: 'The abstract says "an LLM-judge with validated agreement to human raters". Validated is not strong: the paper itself reports a Pearson correlation of 0.62 on factual support and calls that moderate. The page states a weaker version of the claim, which is the definition of this label.' },
  { id: 'mdn-404-always-frustrates', page: 'mdn', label: 'partially_supports',
    claim: 'MDN says every 404 on a website drives visitors away, so broken links must be eliminated.',
    why: 'The page says 404 errors "can lead to a poor user experience" and that broken links "should be minimized to prevent frustration". Can lead is not every, and minimized is not eliminated; the claim is the page with both hedges removed.' },

  // ---------- contradicts ----------
  { id: 'semver-prerelease-higher-precedence', page: 'semver', label: 'contradicts',
    claim: 'Under Semantic Versioning 2.0.0 a pre-release version has higher precedence than the associated normal version.',
    why: 'The page says the opposite in as many words: "Pre-release versions have a lower precedence than the associated normal version." This is the sharpest case in the corpus for token containment, because every token the claim carries is on the page and only the direction of the relation is wrong.' },
  { id: 'semver-v-prefix-valid', page: 'semver', label: 'contradicts',
    claim: 'Semantic Versioning 2.0.0 accepts v1.2.3 as a valid semantic version.',
    why: 'The FAQ asks "Is v1.2.3 a semantic version?" and answers "No, v1.2.3 is not a semantic version." The string the claim rests on is on the page, attached to the denial of the claim.' },
  { id: 'rfc6265-obsoletes-2109', page: 'rfc6265', label: 'contradicts',
    claim: 'RFC 6265 obsoletes RFC 2109 and was published in April 2012.',
    why: 'The header reads "Obsoletes: 2965" and "April 2011", and the abstract says "This document obsoletes RFC 2965." RFC 2109 is cited in the document but is not what it obsoletes, and the year is wrong by one. Both halves of the claim are incompatible with the page.' },
  { id: 'cve-2021-44228-score-9-8', page: 'nvd', label: 'contradicts',
    claim: 'CVE-2021-44228 carries a CVSS 3.1 base score of 9.8.',
    why: 'The record shows 10.0 for CVSS 3.1, twice, and 9.8 appears nowhere on the page. A base score is a single value, so a different one is a contradiction rather than an omission.' },
  { id: 'cve-2021-44228-affects-log4net', page: 'nvd', label: 'contradicts',
    claim: 'The vulnerability also affects log4net and log4cxx.',
    why: 'The description says "this vulnerability is specific to log4j-core and does not affect log4net, log4cxx, or other Apache Logging Services projects". The claim is the negation of a sentence on the page. It is written without a capital or a numeral on purpose: a detector that only looks for tokens has nothing to look for here, and the corpus should contain at least one claim shaped that way.' },
  { id: 'cve-2021-44228-nvd-cvss4', page: 'nvd', label: 'contradicts',
    claim: 'The NVD has assigned CVE-2021-44228 a CVSS v4.0 base score of 10.0.',
    why: 'The page carries a CVSS 4.0 section and the NVD entry under it reads N/A, so the page states that no 4.0 score has been assigned by the NVD. The 10.0 on the page belongs to CVSS 3.1. This is the case where a detector matching a number without its context has every token it needs to agree with a false claim.' },
  { id: 'rfc2119-eight-key-words', page: 'rfc2119', label: 'contradicts',
    claim: 'RFC 2119 defines eight key words for indicating requirement levels.',
    why: 'The abstract lists ten: MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY and OPTIONAL. Eight is a specific count incompatible with the list the page gives, and the word eight appears nowhere in the document.' },

  // ---------- not_addressed ----------
  { id: 'rfc6265-samesite', page: 'rfc6265', label: 'not_addressed',
    claim: 'RFC 6265 defines the SameSite attribute and its Strict, Lax and None values.',
    why: 'SameSite appears nowhere in the fetched text. It was introduced by a later draft, RFC 6265bis, and readers routinely attribute it to 6265 because the document is about exactly this. That is the shape this label exists for: right topic, right document family, and the claim is simply not in the page.' },
  { id: 'deeptrace-303-queries', page: 'arxiv', label: 'not_addressed',
    claim: 'DeepTRACE evaluates 303 queries across nine generative search and deep-research systems.',
    why: 'This is true of the paper and absent from the abstract page that is cited. The page names the systems in passing and gives no corpus size at all. It is the most common real failure in a cited report: a fact taken from a document, attached to a URL that resolves to a summary of that document, where a reader clicking through would not find it.' },
  { id: 'deeptrace-perplexity-unsupported', page: 'arxiv', label: 'not_addressed',
    claim: 'DeepTRACE found that Perplexity in its deep research configuration left 97.5% of its statements unsupported.',
    why: 'Perplexity is named on the abstract page, in the list of systems evaluated, and 97.5% is not on it anywhere. Half the claim can be found and the load-bearing half cannot, which is what makes this harder than a claim with no purchase on the page at all.' },
  { id: 'rfc2119-rfc8174-update', page: 'rfc2119', label: 'not_addressed',
    claim: 'RFC 2119 was updated by RFC 8174, which restricted the key words to their upper-case forms.',
    why: 'RFC 8174 is real and does that, and a 1997 document cannot mention a 2017 one. The fetched text is the original RFC without the status annotations a datatracker page would carry, so a true statement about the document is not in the document.' },
  { id: 'mdn-404-nginx-example', page: 'mdn', label: 'not_addressed',
    claim: 'The MDN page shows an nginx configuration for serving a custom 404 page.',
    why: 'The page shows an Apache .htaccess ErrorDocument example and mentions nginx nowhere. The claim is about a real section of the page with the wrong server named, so the page is about the claim without containing it.' },
  { id: 'rfc6265-truncated-byte-limit', page: 'truncated', label: 'not_addressed',
    claim: 'RFC 6265 asks general-use user agents to support at least 4096 bytes per cookie.',
    why: 'The label is a property of the text supplied, and the supplied text stops at the byte cap long before section 6.1, so the figure is not in it. The full document does state this, which is the point: the same claim against the complete capture is supported. It is here to price the abstention containment makes on a truncated body, which is a deliberate refusal to accuse and costs coverage rather than accuracy.' },

  // ---------- unreadable ----------
  { id: 'linkedin-feed-ai-posts', page: 'linkedin', label: 'unreadable',
    claim: 'LinkedIn users published 3.2 million posts about AI safety in July 2026.',
    why: 'The URL returns HTTP 200 and the body is a sign-in wall: title, a sign-in form, and the footer links. There is no feed content of any kind, so the page cannot bear on the claim either way. Link checking calls this live and is not wrong about what it measured, which is exactly the gap this corpus exists to price.' },
  { id: 'x-home-daily-active-users', page: 'x', label: 'unreadable',
    claim: 'X reported 611 million daily active users on its home timeline in 2026.',
    why: 'The body is the JavaScript-required interstitial, 732 characters of browser advice and policy links, served with HTTP 200. Nothing about a timeline or a user count reached the client, so no verdict about support is available from this text.' },
  { id: 'sciencedirect-blocked-article', page: 'sciencedirect', label: 'unreadable',
    claim: 'The cited article reports that agentic planning improved task completion by 18 percentage points.',
    why: 'The publisher returned HTTP 403 with a block page. The article text was never served, so the claim cannot be judged from what came back. This is the one wall in the corpus that link checking catches, because a 403 is visible in the status line, and it is here so the arm gets credit where credit is due.' },
  { id: 'consent-wall-quarterly-figures', page: 'consent', label: 'unreadable',
    claim: 'The publisher reported quarterly revenue of 4.1 billion euros, up 12% year on year.',
    why: 'The body is a cookie-consent interstitial served with HTTP 200: partner counts, purposes, and Accept and Reject buttons. No article text was served, so nothing here supports or contradicts the figures. A consent wall is the case the brief names specifically, and it is indistinguishable from a working page to anything that only reads a status code.' },
];

for (const c of cases) {
  const page = P[c.page];
  if (page === undefined) throw new Error(`unknown page ${c.page}`);
  const y = (s: string): string => JSON.stringify(s);
  const lines = [
    `id: ${c.id}`,
    `topic: ${y(TOPICS[c.page] ?? c.page)}`,
    `claim: ${y(c.claim)}`,
    `url: ${y(URLS[c.page] ?? '')}`,
    `label: ${c.label}`,
    `why: ${y(c.why)}`,
    'page:',
    `  provenance: ${page.provenance}`,
    `  capturedAt: "${page.capturedAt}"`,
    `  verdict: ${page.verdict}`,
    `  httpStatus: ${String(page.httpStatus)}`,
    `  truncated: ${String(page.truncated)}`,
    `  completeHtml: ${String(page.completeHtml)}`,
    `  textFile: ${page.textFile}`,
    `  textSha256: "${page.textSha256}"`,
    `  textChars: ${String(page.textChars)}`,
    ...(page.note === undefined ? [] : [`  note: ${y(page.note)}`]),
    '',
  ];
  writeFileSync(join(dir, `${c.label.replace(/_/g, '-')}-${c.id}.yaml`), lines.join('\n'), 'utf8');
}
console.log(`wrote ${String(cases.length)} support cases`);
const counts = new Map<string, number>();
for (const c of cases) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
for (const [k, v] of counts) console.log(`  ${k}: ${String(v)} (${(100 * v / cases.length).toFixed(1)}%)`);
