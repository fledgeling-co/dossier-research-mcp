# BENCH-16: nothing records when a source was published

**ID:** BENCH-16
**Status:** In Review
**Created:** 2026-07-28
**Last updated:** 2026-07-28
**Brief:** [BENCH-16](../features-to-triage/BENCH-16-evidence-dates.md)

> **Harness, not product.** Nothing here reaches `dist/` or a user of the npm package. It closes the last scored dimension the benchmark declares and cannot compute.

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-16-evidence-dates.md`.)*

# BENCH-16: nothing records when a source was published

## The gap

`benchmark.md` lists recency as a scored dimension. BENCH-06 built the durability axis it needs, where a standard from 2019 is fresh and a benchmark from 2019 is stale. BENCH-08 then found it **cannot be computed at all**, and says so on every report it renders.

Neither the cell store nor BENCH-03's `PageEvidence` records a publication date. `PageEvidence` carries when a page was **checked**, which is a different fact, and approximating one from the other grades every source fresh, which is the failure the axis exists to catch.

The syndication-collapsed domain count is withheld for the same reason when no page text was compared.

## Why it is not a reporting fix

The data does not exist at the point reporting runs. Closing it means recording a publication date **at evidence-collection time**, which is BENCH-02 (the harness that stores cells) or BENCH-03 (the fetcher that already has the page in hand) rather than BENCH-08.

## What to do

Extract a publication date when a page is fetched, and persist it with the evidence. Then unwithhold recency in the report.

The extraction is the hard part and it is worth being honest about: a publication date can come from a `<meta>` tag, JSON-LD, an Open Graph property, a `<time>` element, a URL path segment, or nowhere at all. **Where it cannot be found, record that it could not be found.** A missing date must not become a guessed one, and a source with no date is a different finding from a source that is old.

## Acceptance

- A fetched page's publication date, or an explicit absence, is persisted with its evidence.
- The report stops withholding recency, and instead reports the share of sources whose date could not be established.
- A source with no discoverable date never scores as fresh.

## Grounding: what a real corpus actually carries

Nothing below is inferred from documentation. Every figure is from fetching the pages on 28 July 2026, and the corpus is the benchmark's own: every distinct URL cited by `bench/tasks/`, `bench/quarantine/` and `bench/detector/`, which is what the collector would really be pointed at. 72 URLs, 60 of which answered 2xx or 3xx.

### The signals that actually appear, in that order of prevalence

| Signal | Pages carrying it | Example |
|---|---|---|
| nothing at all | 43 | `registry.npmjs.org/vitest`, `www.ietf.org/rfc/rfc2119.txt`, every `federalregister.gov` API document |
| `citation_date` / `citation_online_date` | 2 | `arxiv.org/abs/2509.04499` answers `2025/09/02` |
| a `<time>` element | 4 | MDN, CISA, two blogs |
| a date in the URL path | 2 | `msrc-blog.microsoft.com/2021/12/11/...` |
| `article:published_time` | 1 | `bentley.com`, **beside an `article:modified_time`** |
| a site-specific published name | 1 | `kb.cert.org` answers `sei_date_published`, `published_at` |
| a modification date **only** | 3 | Oracle's `Updated Date`, Intel's `lastModifieddate` |

A second probe over 70 URLs cited by this repo's own research documents found the same shape from the other end: **`dateModified` outnumbered `datePublished` four to one** in JSON-LD, 12 against 3.

### Three things that probe settles, which a design written from documentation would have got wrong

**The commonest date on a real page is not a publication date.** Modification dates outnumber publication dates in both probes. An extractor that takes the first date-shaped thing it finds would date `oracle.com/security-alerts/alert-cve-2021-44228.html` to its last touch rather than its publication, and every doc site that rebuilds nightly would grade fresh forever. That is precisely the failure this item exists to prevent, arriving through a different door than the fetch-time approximation the brief warns about.

**A large share of a real corpus is honestly undated, and that is the finding.** 43 of 72 carry no date signal of any kind. JSON APIs, plain-text RFCs, PDFs and rebuilt documentation sites are most of what a technical research report cites. A recency figure computed over such a corpus is computed over a minority of its sources, and the share that could not be dated has to travel beside it or the figure is worse than useless.

**Ambiguity is real and it is in the corpus.** Cisco answers `<meta name="date" content="1/31/2022 9:16:10 PM">`. `1/31` resolves because 31 cannot be a month, and `1/5/2022` would not. A parser that picked a convention would be wrong about half of that class in whichever direction its author's locale happened to fall.

## Design

### Where the date is recorded

In BENCH-03's `PageEvidence`, filled by `collectPage`, which already holds the fetched body. The brief names both candidates and this is the one with the page in hand; the cell store never sees a page.

`EVIDENCE_VERSION` goes to 2. That file's own rule is that the version is "bumped when a field changes meaning, so an old snapshot fails rather than misleads", and a version-1 snapshot genuinely cannot answer the new question. A stale snapshot failing to parse reaches the report as a named pipeline gap, which is the honest outcome; silently reading one as "no dates found anywhere" would print an undated share of 100% about a collection pass that never looked.

### The type carries the distinction, and there is no sentinel

```ts
type PublicationDate =
  | { status: 'found';     date: 'YYYY-MM-DD'; signal: PublicationSignal; raw: string; detail: string }
  | { status: 'absent';    detail: string }
  | { status: 'unchecked'; detail: string }
```

Three states, not two, and the third is the one the whole project keeps re-learning. `absent` means the page was read and states no publication date. `unchecked` means nobody could look: the page did not resolve, or its body was cut short at the byte cap so a date further down was never seen. Collapsing them would let a fetch failure be reported as a publisher who omitted a date, which is the same error as reporting an unreachable registry as a fabricated citation.

There is no `publishedAt?: string` sentinel anywhere on the persisted record. An optional string has exactly one absent state and a caller reading it cannot tell which of the two absences they have, which is how "unchecked is not absent" gets lost between two modules.

### Seven signals, ranked by how explicitly the publisher said "published"

Order is the design. Where two disagree the more explicit one wins, and `signal` is recorded on the result so a wrong date is traceable to the thing that produced it rather than argued about.

| Rank | Signal | What it reads |
|---|---|---|
| 1 | `json-ld` | `datePublished` inside `<script type="application/ld+json">`, schema.org's own machine-readable statement |
| 2 | `citation-meta` | `citation_publication_date`, `citation_date`, `citation_online_date`, `prism.publicationDate` |
| 3 | `article-published-time` | `article:published_time`, the Open Graph article namespace |
| 4 | `dublin-core` | `dcterms.issued`, `dc.date.issued`, then the ambiguous bare `dc.date` |
| 5 | `meta-date` | a named allowlist, plus any meta whose name says `publish` and does not say modified |
| 6 | `time-element` | a `<time datetime="...">` that declares itself a publication date |
| 7 | `url-path` | a year and month adjacent in the path |

### Scepticism, written as four refusals

The brief asks for scepticism about each signal, and each refusal below is a rule rather than a disposition.

**A modification date is never a publication date.** `article:modified_time`, `og:updated_time`, `dateModified`, `lastmod`, `last-modified`, `dcterms.modified`, `revised`, `updated`: any meta name containing one of these words is refused before its value is read, whatever else the name contains. Oracle's `Updated Date` and Intel's `lastModifieddate` are both in the corpus and both are refused by the word rather than by the exact name. Where one was seen and refused, the `absent` detail says so, because "we saw a date and would not use it" is a different finding from "the page carries nothing".

**A `<time>` element proves nothing on its own.** It is as likely to be a comment timestamp, a reading time or an event date. Accepted only when the element itself says what it is: a `pubdate` attribute, `itemprop` naming `datePublished`, or a class naming it published. Otherwise refused with the reason recorded.

**A four-digit number in a URL path is not a year.** `/issues/2019` is an issue number. The path signal requires a year and a month adjacent, `/2024/03/` or `2024-03-15`, which is the form a date in a path actually takes and which an issue number does not.

**A date whose field order cannot be determined is refused.** `1/5/2022` is refused; `1/31/2022` is accepted, because 31 cannot be a month and the order is therefore determined rather than assumed. `raw` keeps the string either way.

Two bounds sit under all seven: a date before 1900, or after the page was fetched, is refused as a misread rather than recorded. A page cannot be published after it was read.

**A fifth refusal, added by measurement rather than by design.** The URL path was originally read even when the page never resolved, since an address survives a failed fetch. Running the finished extractor over 212 real cited URLs refuted it: the only page dated that way was a fabricated URL from the detector corpus, given a fresh 2026 date by its own path. A backend must not be able to supply the evidence it is graded on. The path is now read only on a page that resolved, where something was genuinely served at that address, and that case is still 12 of the 41 dates found.

### What the report does with it

The `recency-fresh-share` metric stops being permanently `null` and becomes a real number, computed by BENCH-06's `scoreRecency` against the **task's** as-of date, over the sources that could be dated. That scorer already refuses to count an undated source as fresh: `assessSourceRecency` returns `freshness: 'undated'` for a source with no date, `dated` excludes it from the denominator, and a report where nothing could be dated comes back `unmeasurable` rather than zero. Nothing about that behaviour needs to change, and the acceptance criterion is met by wiring the caller rather than by trusting it.

Beside it, in the validity panel where the registry `unchecked` share already lives and for the same reason, the report prints how many cited sources could be dated, how many were read and carry no date, and how many were never read. A fresh share of 1.0 over one dated source out of forty is not a finding about a backend, and the only thing that makes it readable is the denominator printed next to it.

## Scope

**In:** the extractor, the persisted field, the collector wiring, the recency wiring in `harvest.ts`, the dating counts through `aggregate.ts`, the render changes, and the docs that carry the withheld claim.

**Out:** the syndication-collapsed domain count. The brief mentions it as withheld "for the same reason", and it is not the same reason: it is withheld when no page **text** was compared, and `PageEvidence` has carried page text since BENCH-03, so the collapsed count already renders whenever a snapshot exists. Nothing to unwithhold.

**Out:** changing the product's own `assessStaleness`. BENCH-06 recorded that as a product decision rather than a benchmark item's, and that reasoning is unchanged.

**Out:** a floor on the dated share below which recency is withheld. `docs/bench/reporting.md` says the floors live in one place and names them; inventing an eighth here would be a second answer to "can this sample support a claim". The denominator is printed instead, which is the shape the registry `unchecked` share already uses.

## Acceptance criteria

Traced in `docs/test-plan.md` as `DATE-01` through `DATE-24`.

1. A fetched page's publication date is persisted on its `PageEvidence`, with the signal that produced it.
2. Where no date can be found, the record says so explicitly, and distinguishes a page that was read and carries none from a page nobody could read.
3. A source with no discoverable date never scores as fresh, proven at the caller rather than only at the scorer.
4. The report computes recency instead of withholding it, and prints the share of sources whose date could not be established.
5. A modification date is never recorded as a publication date.
6. An old snapshot, written before this field existed, fails to parse rather than reporting every source undated.

## What the finished thing could date

212 distinct cited URLs, through the production collection path, 28 July 2026. **41 dated, 151 read in full and stating no publication date, 20 never read.** By signal: `url-path` 12, `citation-meta` 12, `json-ld` 11, `meta-date` 3, `article-published-time` 2, `time-element` 1. Six of the seven fired on a real page, which is what makes the ranking a measured order rather than a guess. Recorded page by page in `bench/evidence/publication-dates.json`.

Four fifths of a technical corpus cannot be dated at all. That is the finding the acceptance criterion about the undated share was written for, and it is larger than the brief guessed at.

## Review

**Out-of-family review.** No Codex lane was available for this item; every reviewer is Claude reviewing Claude, logged here as a downgrade rather than passed off, exactly as BENCH-06 and BENCH-12 recorded. The compensating control is the one BENCH-19 established and this item repeats: a second adversarial read of the whole change **after** the first green gate, budgeted rather than hoped for.
