# Implementation Plan: BENCH-03

**Spec:** [spec-BENCH-03.md](../specs/spec-BENCH-03.md) · **Brief:** [BENCH-03](../features-to-triage/BENCH-03-citation-integrity.md) · **Design of record:** [benchmark.md](../plan/benchmark.md)
**Tier:** Standard
**Written:** 2026-07-27

## Task

Four deterministic checks over a report's citations, plus the published citation dimensions computed from them. Registry existence is the sharpest instrument in the whole benchmark, because a fabricated academic reference either exists in a registry or it does not and no judgement is involved anywhere.

## Approach

**Two halves, and the split is the whole design.**

`collect` touches the network: it walks a report, extracts every identifier and every cited address, asks each registry once per identifier through an on-disk cache, fetches each cited page once through the existing SSRF-safe fetcher, and writes one timestamped, schema-validated **evidence snapshot**. Nothing in it decides a score.

`score` is pure and synchronous over the report text plus that snapshot, and lives beside its three sibling scorers in `bench/src/score/`. Same inputs, same numbers, on any machine, in six months, with the network unplugged.

That is not tidiness. `docs/plan/benchmark.md` stores raw reports precisely so a metric added in three months can be applied to runs already paid for; a scorer that fetches the live web at scoring time makes that impossible, because the web moved. It is also what lets every gate test run hermetically.

## Reference implementation

- `bench/src/score/recency.ts` for the result-union shape (`not-applicable` / `unmeasurable` / `scored`), the "unmeasurable is not zero" rule and the doc-comment register.
- `bench/src/verify/` for the established pure-rules-plus-one-thin-fetch-adapter shape, and `bench/evidence/*.json` for a persisted record of what a network pass established and when.
- `bench/src/tasks/corpus.ts` for the "this file must never import `node:fs`" discipline and the test that enforces it.
- `src/store/store.ts` for atomic write-then-rename, and `src/store/types.ts` for reading a file back as a trust boundary.

## Prerequisites

Merged: BENCH-01 (`bench/src/tasks/`), BENCH-02 (`bench/src/run/`), BENCH-06 (`bench/src/score/`), BENCH-09. Nothing else is needed.

## Steps

### 1. AC rows into the test plan, before the tests

Append a `### BENCH-03` section to `docs/test-plan.md` with the `CITE-nn` rows below. Append only; never reorder another item's rows.

### 2. Nothing in `src/` changes

The cross-family review asked for two additions to `src/net/safe-fetch.ts`, and reading the merged tree disproved both.

**Truncation is already solved in `bench/`, at the adapter.** `safeFetch` caps the read at `maxBytes` and returns no signal that it did, and "the page does not contain the number" and "we stopped reading before the number" are opposite findings. BENCH-09 reached that conclusion first and answered it in `bench/src/verify/cli.ts`, which derives `truncated: Buffer.byteLength(body, 'utf8') >= MAX_BYTES` and carries it on its own `FetchedSource`. Adding a second mechanism inside `src/` would put two definitions of truncation in one tree, which is the disagreement this plan is otherwise at pains to avoid. This slice uses the same idiom and the same exported type. The inference has a three-byte false-negative window, where the decoder holds an incomplete character back, and that is written down in a comment rather than papered over.

**The polite-pool header is not needed.** Crossref's polite pool is reachable through a `mailto` query parameter, verified 27 July 2026: with it the response carries `x-api-pool: polite-single` and `x-rate-limit-limit: 10`, without it `public-single` and `5`. Widening a security-sensitive fetcher's header surface to buy something a query parameter already buys is not a trade worth making.

### 2b. Reuse the matching primitives BENCH-09 already shipped

`bench/src/verify/match.ts` exports `normalise`, `decodeEntities`, `extractText`, `numberForms`, `dateForms` and `valueAppears`, and they are exactly the primitives containment needs. They are reused rather than reimplemented, for the reason that module's own comment gives: a second regex that "finds numbers" would quietly disagree with the first about what a thousands separator is, and a disagreement between two implementations of one rule is invisible until it changes a score.

What is genuinely new here is anchor collection, because `extractText` strips tags and the `id` and `name` attributes go with them.

### 3. Identifiers (`bench/src/score/identifiers.ts`, pure)

Extract and canonicalise the five kinds from a report's cited addresses and from its prose, since a reference is far more often written out than linked.

| Kind | Grammar | Canonical form | Found in |
|---|---|---|---|
| `doi` | `10.\d{4,9}/` + a suffix of `[-._;()/:A-Za-z0-9<>\[\]]` | lower-cased, DOIs are case-insensitive | `doi.org/…`, `dx.doi.org/…`, `doi:10.…`, bare `10.…` |
| `arxiv` | `\d{4}\.\d{4,5}(v\d+)?` or `archive(.SUBJ)?/\d{7}(v\d+)?` | version suffix stripped, archive lower-cased | `arxiv.org/abs/…`, `/pdf/…`, `arXiv:…` |
| `pmid` | 1 to 8 digits **in a PMID context only** | as written, leading zeros stripped | `pubmed.ncbi.nlm.nih.gov/…`, `PMID: …` |
| `isbn` | 10 or 13 digits with optional hyphens or spaces, **checksum-validated** | hyphens stripped, `X` upper-cased | `ISBN …`, `openlibrary.org/isbn/…` |
| `cve` | `CVE-\d{4}-\d{4,}` | upper-cased | anywhere |

Two rules that prevent false accusations. A bare number is **never** a PMID without its context word or host, or every year and page number in the report becomes a fabricated reference. A checksum-failing ISBN is `invalid`, never `absent`: it is a typo, and a typo is not a fabrication.

Trailing sentence punctuation is stripped, and unbalanced closing brackets with it, because a DOI at the end of a sentence otherwise carries the full stop into the lookup.

### 4. Registries (`bench/src/citations/registries.ts`)

Split in two on purpose: a pure `interpret(kind, status, body)` per registry, table-tested against recorded fixtures, and a `request(kind, id)` that only builds a URL. The network sits in step 6 and is injected, so every predicate below is testable with no network at all.

| Kind | Endpoint | `present` | `absent` | else |
|---|---|---|---|---|
| `doi` | `api.crossref.org/works/{id}?mailto=…`, then on 404 `doi.org/api/handles/{id}` | Crossref 200, or handle 200 | handle 404 **and** body `responseCode` 100 | `unchecked` |
| `arxiv` | `export.arxiv.org/api/query?id_list={id}&max_results=1` | 200, feed parses, `totalResults` ≥ 1 and an entry id matching | 200, feed parses, `totalResults` is 0 | `unchecked` |
| `pmid` | `eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id={id}&retmode=json` | 200, `result[id]` present with no `error` | 200, `result[id].error` present | `unchecked` |
| `isbn` | `openlibrary.org/api/books?bibkeys=ISBN:{id}&format=json` | 200, JSON carries the `ISBN:{id}` key | 200, JSON is `{}` | `unchecked` |
| `cve` | `services.nvd.nist.gov/rest/json/cves/2.0?cveId={id}` | 200, `totalResults` ≥ 1 | 200, `totalResults` is 0 | `unchecked` |

Every response body is Zod-parsed; an unparseable body is `unchecked` and never `absent`. **Fail closed in exactly one direction:** anything not positively recognised as one of the two named shapes is `unchecked`. That is what makes a wrong guess about a response shape cost a measurement rather than manufacture an accusation.

The DOI escalation is the finding that matters. Crossref is one registration agency among several, so a real Zenodo identifier is absent from it and present in the handle directory that covers every agency. Verified 27 July 2026: `10.5281/zenodo.3509134` gives Crossref 404 and handle 200. Crossref alone would have called it fabricated.

The ISBN answer is labelled `catalogue-present` / `catalogue-absent` in its own note, never "the book exists". Verified 27 July: the fabricated `9789999999991` returns a real catalogue record, and `9786060606062` returns `{}`. The catalogue is community-edited and incomplete, so it is weak evidence in both directions and says so.

URL building is a trust boundary because the identifier came out of a model. The grammar is validated first (it admits no `?`, `#`, whitespace or `%`), then each `/`-separated segment is percent-encoded and rejoined, and any `..` segment is refused outright.

### 5. Cache, limiter and single flight (`bench/src/citations/cache.ts`)

- **Key:** `{kind}/{sha256(canonicalId)}.json`, namespaced by registry so two kinds cannot collide, hashed so an identifier's own slashes and brackets cannot escape the directory.
- **Write:** temp file then `rename`, the same atomic pattern as the store.
- **Read:** Zod-parsed. A malformed cache entry is discarded and re-fetched, not trusted.
- **Never cached:** `unchecked`. Caching a transient outage freezes it into a permanent verdict, which is the first rule wearing a different hat.
- **Single flight:** an in-process map keyed the same way, so concurrent cells that miss together issue one request. Cross-process locking is **out of scope and stated as such**: the harness is one process, and a lock for a case that does not arise is the speculative abstraction `CLAUDE.md` forbids.
- **Limiter:** one shared minimum gap per registry, applied across all workers. Defaults: Crossref 100ms (it advertises 10/s on the polite pool and the advertised value is honoured when present), arXiv 3s (its stated terms), NCBI 350ms (3/s without a key), OpenLibrary 1s, NVD 6s (5 per 30s without a key). Sleep is injected so tests do not wait.

### 6. The collector (`bench/src/citations/collect.ts`)

Takes a report, an injected registry transport, an injected page fetcher, an injected clock and a cache; returns an evidence snapshot. Bounded concurrency, defaulting well below the harness's own.

Per cited address it records the resolvability verdict from `verifyCitations`, then fetches the page body once through `safeFetch` for the containment and anchor checks. `verifyCitations` throws its bodies away, so the body comes from a direct `safeFetch` call, which is the same fetcher rather than a second one.

HTML is reduced to text by `extractText` from `bench/src/verify/match.ts`, which already drops script, style and comment content before stripping tags and decodes entities afterwards. Anchor names are collected separately from the raw HTML by a new `collectAnchors`, since `extractText` throws the attributes away with the tags.

### 7. The evidence snapshot (`bench/src/citations/evidence.ts`, no `node:fs`)

One Zod schema, one version field, and the timestamps that make it re-scorable: when it was collected, each page's own `checkedAt`, its final URL after redirects, its HTTP status, whether the body was truncated, whether it was complete readable HTML. Read back from disk it is a trust boundary and is parsed, never cast.

### 8. Containment and anchors (`bench/src/score/containment.ts`, pure)

**Checkable tokens**, in this exact order, from a statement:

1. Percentages, `28.6%`, kept whole.
2. Numbers with optional thousands separators and decimals, `1,200` and `28.6`, plus a scale word where one follows (`billion`).
3. Four-digit years, 1000 to 2999.
4. Identifiers already extracted from the statement.
5. Proper nouns: a capitalised word not at the start of a sentence, and runs of them joined, minus a stop list of sentence-initial and common capitalised words.

Normalisation for matching: Unicode NFKC, case-folded, thousands separators removed, `%` kept, curly quotes and non-breaking spaces folded to their plain forms. A number matches its own normalised form; `28.6%` also matches `28.6 percent`.

**The verdict rule.** All extracted tokens must be present in the page text for `supported`. Any token absent gives `unsupported`. Three cases give `unchecked` rather than `unsupported`, and each is the difference between a measurement and an accusation:

- The statement yields **no** checkable token, so there was nothing to check.
- The page was not fetched, or was not readable, or its verdict was not `live`.
- The page body was **truncated** and no match was found, so absence is unproven.

**Anchors.** Scoped to a fragment that decodes to a plain identifier, on a response that is complete readable HTML. Present in the collected `id`/`name` set is `honest`; absent is `missing`. A text fragment (`#:~:text=`), a PDF page fragment, a non-HTML body, a truncated body or a fragment on a page that did not resolve are `not-applicable` or `unchecked`. Treating every non-match as dishonest would manufacture accusations at scale, which is the failure this slice exists to avoid.

### 9. The matrix (`bench/src/score/matrix.ts`, pure)

Statements come from a deterministic segmentation: `normaliseCitations` first so `<cite>` tags become links, fenced code and HTML comments dropped, headings and table separator rows skipped, list items and table data rows one statement each, prose split on sentence terminators behind an abbreviation and decimal guard. A citation appearing in the gap after a terminator attaches to the preceding statement, which is how people write.

Sources are the distinct canonical addresses from `extractCitedUrls`, canonicalised by `canonicaliseUrl`, sorted, so the ordering is identical on every machine.

- **Citation matrix `C`**: statement *i* cites source *j*.
- **Support matrix `F`**: the oracle says source *j* supports statement *i*.
- **Citation accuracy** `Σ(C⊙F) / Σ(C)`, null when nothing is cited.
- **Citation thoroughness** `Σ(C⊙F) / Σ(F)`, null when nothing is supported or the pair budget was exceeded. `F` is over **all** pairs, not only cited ones, which is what makes thoroughness mean anything; the pair count is capped and the cap is reported when it binds.
- **Uncited sources**, the empty columns of `C`.
- **Unsupported statements**, cited statements no cited source supports. Reported over **cited** statements, not over relevant ones, because relevance needs a judgement and this path has none.
- **Source necessity**: the source side of a minimum vertex cover of `C`, from Hopcroft-Karp plus the Konig construction, over the sorted ordering above.

Two dimensions are reported **unavailable with the reason** rather than approximated: `relevantStatements` and everything derived from it, and `oneSidedAnswer` with `overconfidentAnswer`. Both need a relevance or stance judgement. An approximated dimension published under a known name is worse than an absent one, and one-sidedness is BENCH-05's subject anyway.

**Necessity depends on a tie-break and says so.** A minimum vertex cover is not unique, and two equally-small covers can have different source-side sizes. The construction is deterministic given the pinned ordering, so the number is reproducible; it is not canonical. `sourceNecessityTieDependent: true` rides on the result, and a canonical companion is reported beside it: `uniquelyCitedSources`, the count of sources that are the only citation on at least one statement, which cannot vary and is a lower bound on any necessary set.

### 10. The support oracle seam

```ts
export type SupportVerdict = 'supported' | 'unsupported' | 'unchecked';
export interface SupportOracle {
  readonly name: 'containment' | 'judged';
  judge(statement: Statement, source: SourceEvidence): SupportVerdict;
}
```

`containmentOracle()` is the default and the only one the gate runs. `judgedOracle(judge)` wraps an injected function so BENCH-10 can supply a model without this slice importing one, which keeps "no model in the default path" true while making the judged variant a real, owned contract rather than a slot. The oracle's `name` rides on every result, so no number can be read without knowing which produced it.

### 11. The pure top level (`bench/src/score/citations.ts`)

`scoreCitationIntegrity(report, evidence, options)`. Two arms, both carrying `volume`:

- `unmeasurable` with reason `no-citations` (a real finding about the backend) or `no-evidence` (a pipeline gap, never a penalty against the backend).
- `scored`, every rate `number | null`, every null explained in `notes`.

**Volume is a first-class member of both arms**, which is the one place this deliberately diverges from the sibling scorers' shape. A hundred sources at eighty percent and ten at eighty percent are different products, and a result that hides the count when the rate is unmeasurable cannot tell them apart.

### 12. Barrels, docs and the shared files

Export from `bench/src/score/index.ts` and a new `bench/src/citations/index.ts`. Write `docs/bench/citation-integrity.md`: the registry table with every endpoint, predicate and the date it was verified, the containment rule, what each number cannot mean, and the standing caveat that containment is not entailment. Add the `bench/src/citations/` and new `src/score/` lines to the `CLAUDE.md` layout block. One CHANGELOG entry under Unreleased. Update the BENCH-03 ledger row only.

## Edge cases

- A report with no citations at all: `unmeasurable / no-citations`, volume all zero. A finding, not an error.
- Every registry down: a full result in which every registry answer is `unchecked` and every registry rate is null.
- A DOI in Crossref but not the handle directory: `present`, because Crossref answered first and 200 is 200.
- The same identifier written three ways in one report: canonicalised to one lookup.
- A page that resolves but returns 20 bytes of JavaScript: containment `unchecked`, not `unsupported`.
- A statement that is a heading, a table separator or pure punctuation: not a statement.
- A URL that `safeFetch` refuses as private or malformed: recorded as `invalid_url`, its containment `unchecked`.
- A cache file corrupted by hand: discarded and re-fetched.

## Acceptance criteria

| AC | Criterion |
|---|---|
| **CITE-01** | A known-good DOI scores `present` |
| **CITE-02** | A well-formed but non-existent DOI scores `absent`, and only when the handle directory confirms it |
| **CITE-03** | A DOI absent from Crossref but present in the handle directory scores `present`, never `absent` |
| **CITE-04** | Every registry transport failure, timeout, 429 and 5xx scores `unchecked` |
| **CITE-05** | An `unchecked` answer is excluded from the denominator of every rate |
| **CITE-06** | An `unchecked` answer is never written to the cache |
| **CITE-07** | The same identifier across many reports is looked up once, and concurrent misses collapse onto one request |
| **CITE-08** | A cache entry is written atomically and Zod-parsed on read; a corrupt entry is discarded, not trusted |
| **CITE-09** | The per-registry minimum gap is respected across concurrent workers, and Crossref's advertised limit is honoured when it sends one |
| **CITE-10** | Crossref is addressed with the polite-pool `mailto` parameter |
| **CITE-11** | A PMID answer is decided by the body's `error` key, not by the 200 status |
| **CITE-12** | A CVE answer is decided by `totalResults`, not by the 200 status |
| **CITE-13** | An ISBN result is labelled catalogue presence in both directions, and a checksum failure is `invalid`, never `absent` |
| **CITE-14** | An arXiv id is extracted with its version stripped, and a 429 is `unchecked` |
| **CITE-15** | A bare number is not a PMID without its context word or host |
| **CITE-16** | An identifier containing a path-traversal segment is refused before any request is built |
| **CITE-17** | Identifiers are found in the report's prose as well as in its linked addresses |
| **CITE-18** | Containment reports `supported` only when every checkable token is present |
| **CITE-19** | A statement with no checkable token is `unchecked`, never `unsupported` |
| **CITE-20** | A truncated page body with no match is `unchecked`, never `unsupported` |
| **CITE-21** | `28.6%` matches `28.6 percent`, and `1,200` matches `1200` |
| **CITE-22** | Containment is labelled as containment in the result and never as claim verification |
| **CITE-23** | An anchor present in the page's `id`/`name` set is honest; absent is missing |
| **CITE-24** | A text fragment, a PDF page fragment and a non-HTML body are `not-applicable` or `unchecked`, never `missing` |
| **CITE-25** | Statement segmentation ignores fenced code, headings and table separators, and does not split on a decimal or a common abbreviation |
| **CITE-26** | A citation in the gap after a sentence terminator attaches to the preceding statement |
| **CITE-27** | Citation accuracy is `Σ(C⊙F)/Σ(C)` and is null when nothing is cited |
| **CITE-28** | Citation thoroughness is `Σ(C⊙F)/Σ(F)` over all pairs, and is null when the pair budget binds |
| **CITE-29** | Source necessity is the source side of a minimum vertex cover, deterministic under the pinned ordering |
| **CITE-30** | Source necessity reports that it is tie-dependent, and `uniquelyCitedSources` is reported beside it |
| **CITE-31** | Uncited sources are the empty columns of the citation matrix |
| **CITE-32** | Unsupported statements are counted over cited statements, and the divergence from the published definition is stated |
| **CITE-33** | The relevance-dependent dimensions are reported unavailable with a reason, never approximated |
| **CITE-34** | Citation accuracy and citation volume are separate numbers on every result, including the unmeasurable arm |
| **CITE-35** | The support oracle's name rides on every result |
| **CITE-36** | The judged oracle is reachable by injection and no model is imported on the default path |
| **CITE-37** | Scoring is pure: `bench/src/score/*` imports no filesystem and no network, asserted by reading the modules' own source |
| **CITE-38** | The same report and snapshot score identically twice |
| **CITE-39** | A report with no citations is `unmeasurable / no-citations` and still reports volume |
| **CITE-40** | With every network call failing, collection still returns a complete snapshot |
| **CITE-41** | A truncated page body is carried as truncated through collection into the containment verdict |
| **CITE-42** | Number and text matching goes through BENCH-09's shared primitives, so the two slices cannot disagree about a thousands separator |

## Verify

`npm run gate`, twice. Then the stdio smoke: build, spawn `dist/index.js`, `initialize`, `tools/list`, call `research_plan`, assert on the response. `bench/` is not compiled into `dist/`, so the smoke is a regression check on the one `src/` file this touches.

Live registry probes are a documented manual step and are **never** in the gate: they are non-hermetic and their answers move.

## Out of scope

No model on the default path. No entailment. No cross-process lock. No reporting or aggregation, which is BENCH-08. No labelled detector corpus or confusion matrix, which is BENCH-10. No syndication detection, which is BENCH-07.
