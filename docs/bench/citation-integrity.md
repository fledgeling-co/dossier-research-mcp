# Citation integrity

The sharpest instrument in the benchmark, and the one whose wrong answer is most expensive. A fabricated academic reference is the canonical failure of this whole product category, and it either exists in a registry or it does not, with no judgement anywhere.

The design is [`docs/plan/benchmark.md`](../plan/benchmark.md). The task format these read is [`task-format.md`](task-format.md), and the three other scorers are in [`scoring.md`](scoring.md).

## The rule everything else is arranged around

**A registry that could not be reached records `unchecked`, never `absent`.**

`absent` means "this reference was fabricated". Saying that because a server was busy is the benchmark becoming the thing it exists to detect, and it would land on a backend that did nothing wrong. So every check here fails closed in exactly one direction: an answer is `absent` only when a registry positively said so, in a shape this code recognises. A timeout, a 429, a 500, an unparseable body, a response shape that changed since this was written, all of them are `unchecked`.

`unchecked` then leaves every denominator. That is the same rule expressed as arithmetic, and it is worth stating separately because it is easy to get half right: recording the correct verdict and then dividing by it anyway still lowers the backend's score.

## Two halves, and why they are separate

**Collection** touches the network. It walks a report, asks each registry once per identifier through an on-disk cache, fetches each cited page once, and writes one timestamped evidence snapshot. It decides no scores.

**Scoring** is pure and synchronous over the report plus that snapshot. Nothing in `bench/src/score/` reads a file or opens a socket, and a test walks the import graph to prove it rather than reading the first line of each module.

The split is not tidiness. `benchmark.md` stores raw reports precisely so a metric added in three months can be applied to research already paid for, and a scorer that fetched the live web at scoring time could never deliver that, because the web moved. It is also what lets the whole surface run in the gate with no network.

## The five registries

Every endpoint and every predicate below was checked against the live service on **27 July 2026**, not taken from documentation. Three of the five do not behave the way the brief assumed, and reading the docs would have shipped all three defects.

| Identifier | Endpoint | `present` | `absent` | Everything else |
|---|---|---|---|---|
| DOI | `api.crossref.org/works/{id}`, then on any non-200 `doi.org/api/handles/{id}` | Crossref 200, or handle 200 | handle 404 **and** body `responseCode` 100 | `unchecked` |
| arXiv | `export.arxiv.org/api/query?id_list={id}` | 200, `totalResults` at least 1, **and** an entry whose own id is the one asked about | 200 and `totalResults` 0 | `unchecked` |
| PMID | `eutils.ncbi.nlm.nih.gov/.../esummary.fcgi?db=pubmed&id={id}&retmode=json` | 200 and `result[id]` with no `error` | 200 and `result[id].error` | `unchecked` |
| ISBN | `openlibrary.org/api/books?bibkeys=ISBN:{id}&format=json` | 200 and the `ISBN:{id}` key is present | 200 and the body is `{}` | `unchecked` |
| CVE | `services.nvd.nist.gov/rest/json/cves/2.0?cveId={id}` | 200 and `totalResults` at least 1 | 200 and `totalResults` 0 | `unchecked` |

### What the live check changed

**Crossref alone would report a genuine reference as fabricated.** Crossref is one DOI registration agency among several, so a DOI minted by another is simply not in it. The real, live `10.5281/zenodo.3509134` answers 404 from Crossref and 200 from the global handle directory. An `absent` verdict therefore rests on the handle directory, which covers every agency; Crossref is only the faster first place to look, and its 404 decides nothing on its own.

**The book catalogue answers found for a made-up number.** `9789999999991` was fabricated for this test and resolves to a real OpenLibrary record that lists exactly that number; `9786060606062` returns `{}`. OpenLibrary is community-edited and its coverage is incomplete, so an ISBN result is **catalogue presence, never proof a book exists**, and the detail on every answer says so in both directions.

**arXiv refuses ordinary use.** Every lookup across a seven-minute span answered `429 Rate exceeded`, after only a handful of requests. `unchecked` is the ordinary answer from that archive rather than the rare one, and it is the clearest argument in the whole slice for why the first rule had to be written down before any code was.

**A count is not an answer.** arXiv's result count alone does not say which paper the feed describes, so a `present` verdict also requires an entry whose own id is the one that was asked about. A feed naming a different paper is `unchecked`.

**Two registries answer 200 for something that does not exist.** A missing PMID is an HTTP 200 carrying `{"error":"cannot get document summary"}` on the entry, and an unknown CVE is an HTTP 200 with `totalResults: 0`. Reading the status alone would have scored every fabricated reference in both as real.

### Rate limits, and the polite pool

One minimum gap per registry, shared across every caller rather than applied per caller: a limit divided among eight concurrent cells is not the limit the service asked for.

| Registry | Gap | Where it comes from |
|---|---|---|
| Crossref | 200ms, or 100ms with a contact address | the pool the response reports: `public-single` allows 5 a second, `polite-single` allows 10 |
| DOI handle directory | 200ms | politeness; the service publishes no limit |
| arXiv | 3s | its stated terms, one request every three seconds |
| NCBI E-utilities | 350ms | 3 a second without an API key |
| OpenLibrary | 1s | politeness; the service publishes no limit |
| NVD | 6s | 5 per rolling 30 seconds without an API key |

Crossref's polite pool is joined by a `mailto` query parameter, verified: with it the response carries `x-api-pool: polite-single` and `x-rate-limit-limit: 10`, without it `public-single` and `5`. It is an option with **no default** rather than a constant, because the address belongs to whoever is running the benchmark and baking one person's inbox into a shared tool is not a decision this code gets to make. Set `crossrefMailto` and the allowance doubles.

The limit each response *advertises* is deliberately not read. `safeFetch` surfaces no response headers, and widening a security-sensitive fetcher to expose them buys nothing the static gaps above do not already give, since each is at or below what its service publishes.

### Caching

One small JSON file per identifier, keyed `{kind}/{sha256(id)}`, under `~/.dossier-research-mcp/bench/registry-cache` by default. Namespaced so two kinds cannot collide, hashed because a DOI's own slashes are not legal in a file name and building a path out of untrusted text is how a cache write escapes its directory.

Written temp-then-rename, read back Zod-parsed. An entry that does not parse, or whose recorded identity disagrees with what was asked for, is discarded and looked up again: a hand-edited or truncated file must not be able to assert that somebody's citation was fabricated.

**An `unchecked` answer is never written.** Caching a transient outage freezes it into a permanent verdict inherited by every later report, without one of them making the request that would correct it.

Concurrent callers that miss together collapse onto one request through an in-process single-flight map. A cross-process lock is deliberately absent and said so: the harness is one process, and building a lock for a case that does not arise is the speculative abstraction `CLAUDE.md` forbids.

## Finding the identifiers

An identifier is extracted bare **only when its own grammar identifies it**. A DOI starts `10.` followed by four to nine digits and a slash, and a CVE spells its own name, so both stand alone anywhere in the text. A PMID is a bare run of digits, an ISBN is a bare run of digits and an arXiv id is a bare decimal number, so all three need a context word or a host: without that rule, every year, page number and version string in a report becomes a reference no registry has heard of, and the registry then truthfully calls it absent.

A trailing full stop is stripped, and an unbalanced closing bracket with it, because a DOI at the end of a sentence otherwise carries the punctuation into the lookup and comes back absent for reasons of typography.

**An ISBN whose check digit disagrees with its body is `invalid`, never `absent`.** A mistyped number is a typo, and sending it to a catalogue that will truthfully say it has never heard of it reads as a fabricated citation. A DOI carrying a path-traversal segment is refused before any URL is built.

One known limitation, stated rather than hidden: a path segment reading `10.dddd/something` inside an unrelated URL matches the DOI grammar. It is rare, and the alternative is dropping the publisher URLs that legitimately carry a DOI in their path, which is most of them. The escalation to the handle directory is the second guard on the verdict that would matter.

## Token containment

**Containment is not entailment.** A page can contain "28.6%" while saying something else entirely about it, and this check cannot tell the difference. It is deliberately weaker than a reader's judgement and deliberately exact, repeatable and free, which for a regression suite that would otherwise be run once is the better bargain. It is reported as containment everywhere it appears and never as claim verification.

The checkable tokens are the brief's own list, extracted in this order so that a percentage claims its own digits before a bare number can:

1. Percentages, kept whole with the sign attached in every spelling.
2. Numbers with a scale word, matched both as written and expanded.
3. Four-digit years.
4. Any remaining number, with thousands separators and decimals.
5. Identifiers.
6. Proper nouns, with runs joined, skipping the first word of the statement and a fixed list of sentence-opening words.

Matching goes through the primitives `bench/src/verify/match.ts` already ships, rather than a second set written here. That module's own comment gives the reason: a second regex that finds numbers would have to decide what a thousands separator is in a document whose locale it does not know, and would quietly disagree with the first.

**Every token must appear for `supported`.** Three cases answer `unchecked` rather than `unsupported`, and each is the difference between a measurement and an accusation: the statement carries nothing checkable, the page never resolved, or the page body was cut short and nothing matched, so absence is unproven.

Proper-noun strictness is the main source of `unsupported` and is a known weakness rather than a tuned parameter: a page can support a claim about a company while calling it "the company" throughout. Measuring that weakness rather than hand-tuning it away is BENCH-10's job.

## Anchor honesty

Scoped hard: decoded HTML `id` and `name` anchors, on a complete readable HTML response. A text fragment, a PDF page number, a body that is not HTML, a body that was cut short and a page that did not resolve are `not-applicable` or `unchecked`. Treating every non-match as dishonest would manufacture accusations at scale out of fragment forms this check was never able to read.

## The published dimensions

Adopted from DeepTRACE (arXiv 2509.04499, ICLR 2026), read from the paper rather than from a summary of it, because adopting a published metric set is what makes a number here comparable with everybody else's.

| Dimension | How it is computed |
|---|---|
| Citation accuracy | the elementwise product of the citation and support matrices, over the citations whose support could be decided |
| Citation thoroughness | that same product over every supported pair, cited or not |
| Uncited sources | the empty columns of the citation matrix |
| Unsupported statements | rows of the support matrix with no supported cell |
| Source necessity | the source side of a minimum vertex cover of the **support** graph, over the number of sources listed |
| Citation volume | statements, sources, citation edges, and citations per statement |

### Three departures, each named on the result

**The support matrix comes from containment, not a model judge.** The paper judges support with a model; the benchmark's governing rule forbids a model in the scoring loop. Both are kept: containment is the default because it is free and repeatable, the judged variant is a real interface, and BENCH-10 scores the two against one labelled corpus so the gap is a measurement rather than an assumption.

**The denominators are not relevance-filtered.** The paper's denominators are *relevant* statements. Deciding relevance needs a judgement this path does not have, so the denominators here are the statements whose support could be decided, and `relevantStatements`, `oneSidedAnswer` and `overconfidentAnswer` are reported **unavailable with a reason** rather than approximated. An approximated dimension published under a known name is worse than an absent one.

**The oracle is ternary and the paper's matrices are binary.** An `unchecked` pair leaves every denominator instead of counting as unsupported.

### Accuracy and volume are always two numbers

Never one. The published work found citation count and citation correctness close to orthogonal in current systems while human preference tracks the count, so a backend citing a hundred sources at eighty percent and one citing ten at eighty percent are different products that a single collapsed score cannot tell apart. Volume therefore rides on every result **including** the arm that cannot compute a rate, which is the one place this deliberately diverges from the shape of its sibling scorers.

### Two things about source necessity

It is computed over the **support** matrix, not the citation matrix. Computing it over citations would publish a different quantity under a published name, which is the one thing adopting a published metric is supposed to prevent.

And the number **depends on which minimum cover the construction lands on**. A minimum vertex cover is not unique, and two covers of equal size can have different source sides; where every statement is matched the construction returns a cover made entirely of statements, whose source side is zero. The ordering is pinned so the answer reproduces on any machine, and it is not canonical, so a comparison between two backends must not rest on this number alone. `uniquelyCitedSources`, the count of sources a report relies on alone, is reported beside it and cannot vary.

## What a statement is

Deterministic segmentation, which is the requirement rather than linguistic accuracy: a denominator that shifts between two runs over the same text makes every rate incomparable with itself. Fenced code and HTML comments are dropped, headings and table separator rows are skipped, list items and table data rows are one statement each, and prose splits on sentence terminators behind an abbreviation guard. A decimal never splits, because the boundary requires whitespace after the stop. A citation written after the full stop attaches to the sentence before it, which is how people write.

Segmentation runs over the **raw** report. Normalising citations first rewrites any citation whose scheme the renderer will not link into inert backticked prose, taking the URL with it, so a report whose only citations were of that kind would come back carrying none.

**Evidence-table and bibliography rows are excluded from the citation matrix**, and their URLs stay in the source universe. This product's own prompt asks for an evidence table listing every source, so without the exclusion each listed source appears in a row that cites it, no column of the citation matrix is ever empty, and uncited sources is zero for every backend forever.

## What each number cannot mean

- A `present` registry answer does not mean the reference says what the report claims it says. It means the identifier exists.
- A `catalogue-present` ISBN does not mean the book exists, and a `catalogue-absent` one does not mean it does not.
- A `live` URL does not mean the page supports the claim attached to it. It means the URL resolves.
- A `supported` containment verdict does not mean the page supports the claim. It means the page contains the numbers, years, identifiers and names the statement asserts.
- A high citation accuracy over few citations is not the same finding as a high one over many, which is why volume is never folded in.
- `sourceNecessity` is reproducible, not canonical.

## Running it

`citationBatch()` is the wired arrangement: the live adapters, the on-disk answer cache and one coordinator shared across every report in a run. It exists because every part of this slice is injectable so the gate can drive it offline, and that leaves an obligation somebody has to discharge. Built per report instead of per batch, the limiter enforces a gap per report rather than per registry and two concurrent cells both miss the cache for the same identifier, so "the same DOI across forty reports is one lookup" would hold only if a future caller happened to wire three objects together correctly.

```
const batch = citationBatch({ registryOptions: { crossrefMailto: 'you@example.com' } });
await batch.collect(cellKey, report);      // fetches, remembers, writes the snapshot
const result = batch.score(cellKey, report); // reads it back and scores, purely
```

`score` refuses a snapshot collected from a different report and reports that as no evidence, never as a result about a backend.

BENCH-08 still owns what a run *reports*. The gate covers every decision either half makes, with an injected transport, an injected clock and a temporary directory. The SSRF boundary is exercised for real, because a private address is refused before a socket opens, so driving the live fetcher at one stays hermetic. Live registry probes are a manual step and are deliberately never in the gate: they are not hermetic and their answers move.
