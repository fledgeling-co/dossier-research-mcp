# BENCH-03: Citation integrity scorers

**ID:** BENCH-03
**Status:** In Review
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-03](../features-to-triage/BENCH-03-citation-integrity.md) · **Design of record:** [benchmark.md](../plan/benchmark.md) · **Prior art:** [benchmark-prior-art.md](../deep-research/benchmark-prior-art.md)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-03-citation-integrity.md`.)*

# BENCH-03: citation integrity scorers

## What

Four deterministic checks over a report's citations, in increasing strength.

1. **Resolvability.** The URL returns 2xx. `src/research/citations.ts` already does this with SSRF checks and redirect validation; reuse it rather than writing a second fetcher.
2. **Registry existence.** A DOI resolved against Crossref, an arXiv id against the arXiv API, a PMID against NCBI E-utilities, an ISBN against OpenLibrary, a CVE against the NVD.
3. **Claim-token containment.** Extract the checkable tokens from the claim (numerals, percentages, proper nouns, years) and require them in the fetched page text.
4. **Anchor honesty.** A cited URL carrying a fragment must contain that anchor.

## Why this is the most valuable slice

Registry existence is exact, free hallucination detection for the canonical failure of this entire product category. A fabricated academic citation either resolves in Crossref or it does not, and no judgement is involved at any point.

## Requirements

- Every registry call is cached on disk by identifier. The same DOI appearing in 40 reports must be looked up once.
- A registry being unreachable is recorded as `unchecked`, never as `absent`. This is the single most important rule in the slice: reporting a network failure as a fabricated citation would accuse a backend of the exact thing the benchmark exists to detect.
- Rate limits respected per registry, with the polite pool conventions Crossref asks for.

## Acceptance

- A known-good DOI scores present; a well-formed but non-existent DOI scores absent; an unreachable registry scores unchecked and is excluded from the denominator.
- Token containment reports what it is, never as claim verification. A page can contain "28.6%" while saying something else entirely about it. This check is weaker than a model's judgement and it is exact, repeatable and free, which for a regression suite is the better bargain.

## Adopt DeepTRACE's dimensions rather than inventing metrics

Amended 27 July 2026 after the prior-art research. DeepTRACE (arXiv 2509.04499, ICLR 2026) specifies its dimensions at formula level and separates **accuracy from thoroughness from necessity**. That third one is the distinction this brief was missing: it catches over-citing, where a report attaches sources to everything and scores well on any metric that only asks whether cited things are real.

Report citation accuracy and citation **volume** as separate numbers, always. A backend citing a hundred sources at 80% accuracy and one citing ten at 80% are not the same product, and a single collapsed score cannot tell them apart.

Adopting published metrics also makes results comparable with everyone else's, which inventing a private set destroys.

## Where this design and the published one genuinely disagree

DeepTRACE's support check uses a model judge. This design forbids a model in the scoring loop and uses token containment instead.

Keep both, and be plain about which is which. **Containment is the default**, because it is free, exact and repeatable, and because a regression suite that costs money per run gets run once. The judged variant is available for anyone who wants the stronger check. BENCH-10 scores the two against the same labelled corpus, so the gap between them is a measurement rather than an assumption, and if containment turns out to be much weaker that is a finding worth having rather than a decision to defend.

## Non-goals

No entailment in the default path. No model in the default path.

### Fleet context carried with the brief

- The governing rule for the whole benchmark: **no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run.
- `bench/src/tasks/` holds the schema BENCH-01 merged; build against it.
- `src/research/citations.ts` already does SSRF-safe fetching with redirect validation. Reuse it; do not write a second fetcher.
- Three rules that must hold: an unreachable registry records `unchecked` and never `absent`; every registry lookup is cached on disk by identifier; token containment is reported as what it is and never as claim verification.
- Verification is `npm run gate` plus a protocol-level stdio smoke test against `dist/index.js`, and the suite runs twice. No UI, so no Playwright.

---

## Triage — 2026-07-27

**Ready for Implementation Plan**

**Sentinel review:** S1 — Approve with assumptions

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes; the whole item is a scoring library that runs on a developer's machine.)*

### What the grounding pass found, and what it changed

Three of the five registries behave differently from what the brief assumes. All three were checked against the live services on 27 July 2026 rather than taken from documentation, which is this repo's standing rule for anything an adapter depends on.

1. **Checking a reference against Crossref alone would report a genuine reference as fabricated.** Crossref is one of several agencies that issue permanent article identifiers; a reference issued by a different agency is simply not in it. A real, live identifier for a published dataset came back "not found" from Crossref and "found" from the global directory that covers every agency. Since the whole point of this slice is refusing to accuse a backend of inventing a reference, the global directory has to be the deciding answer and Crossref is the first, faster place to look.

2. **The book catalogue answers "found" for a made-up book number.** A deliberately fabricated thirteen-digit book number came back attached to a real catalogue record that lists exactly that number. The catalogue is community-edited, so it contains junk entries, and its coverage of real books is also incomplete. So a book result is reported as catalogue presence and never as proof the book exists, in either direction.

3. **The preprint archive refuses ordinary use.** Two lookups a minute apart were both refused for exceeding its rate limit. This is not a hypothetical: the "could not check" answer is the common case for that archive, not the rare one, and it confirms the brief's first rule was the right one to write down.

Two more shapes matter and are handled: the medical index answers "success" with an error buried in the body for a reference that does not exist, and the vulnerability database answers "success" with a result count of zero. Reading the response status alone would score both as found.

**Assumptions**

- `[Data & scope]` A permanent article identifier is decided by the global directory that covers every issuing agency, with the faster catalogue asked first and the directory consulted only when it says no. *(rather than the faster catalogue alone: verified 27 July, a real identifier is missing from it.)*
- `[Data & scope]` A book number result reports catalogue presence, never publication existence, in either direction. *(verified 27 July: a made-up number resolves to a real record.)*
- `[Operations]` A registry that refuses, times out, rate-limits or errors records "not checked", and every "not checked" is left out of every share. *(the brief's first rule.)*
- `[Operations]` Every answer is remembered on disk keyed by the identifier, and a "not checked" is never remembered as an answer. *(a cached failure would freeze a temporary outage into a permanent verdict.)*
- `[Operations]` The remembered answers live beside the existing local run store rather than inside the project folder, so scoring never dirties the working copy. *(matches where run history already lives.)*
- `[Operations]` Each registry gets a conservative minimum gap between requests, and a registry that advertises its own limit has that honoured instead. *(one of them publishes a limit on every response.)*
- `[Experience]` How right the citations are and how many there are are always two separate numbers, never one. *(the published work's own finding: a hundred sources at eighty percent and ten at eighty percent are different products.)*
- `[Operations]` Word-and-number containment is the default support check and the judged variant is a slot somebody else fills, off by default. *(the brief keeps both deliberately; BENCH-10 measures the gap.)*
- `[Data & scope]` Two of the published dimensions need a relevance judgement and are reported as unavailable with the reason, rather than approximated. *(an approximated dimension published under a known name is worse than an absent one.)*
- `[Data & scope]` Identifiers are looked for in the linked addresses and in the report's own words, since a reference is commonly written out rather than linked. *(a linked-only search would miss most of them.)*
- `[Operations]` With no network at all the scorer still produces a full result in which every registry answer is "not checked". *(scoring must be runnable offline, and silence must look like silence.)*
- `[Compliance]` The one measure whose answer can depend on which of several equally-small answers is picked reports that dependence in its own output, and a second measure that cannot vary is reported beside it. *(a comparison between backends must not rest on a tie-break.)*

*If any of these are wrong, edit it inline (or correct an assumption) in this file and re-run `/triage BENCH-03` before the planner picks this up.*

**Codex cross-family spec review — 2026-07-27**

`gpt-5.6-sol` at `max` effort, read-only, over the spec, the brief, the design of record and the code each names. **Verdict: MATERIAL DEFECTS**, ten findings. No downgrade: the lane was available. Seven accepted, two accepted in part, one made moot by a merge that landed while this ran.

| # | Finding | Disposition |
|---|---|---|
| 1 | The published dimensions need statement-by-source matrices, and neither statement segmentation nor the source universe was defined. `extractCitedUrls` returns deduplicated URLs and throws away which claim each was attached to, so accuracy, thoroughness and necessity are all uncomputable from it. Volume was undefined. | **Accepted.** An occurrence-level model is now the contract: statements, sources, citation edges, support edges, with every formula written down and every dimension that needs a relevance judgement named as unavailable rather than approximated. |
| 2 | The judged variant was shrunk to an unowned slot, so BENCH-10 would have nothing to compare against. | **Accepted in part.** The support oracle becomes a named interface with two shipped implementations: containment, which is the default, and a judged adapter that takes an injected judge. No model enters this slice; BENCH-10 supplies one. Rejected the part asking for an owner assignment, which the fleet plan already carries. |
| 3 | Live HTTP and disk writes inside a scorer contradict the purity the sibling scorers hold to, and mean the same stored report can score differently later. | **Accepted, and it is the largest change.** Evidence collection and scoring are now two halves: a collector that touches the network and writes a timestamped, schema-validated evidence snapshot, and a pure synchronous scorer over the report plus that snapshot. This is what the design of record already asks for when it says a metric added later must be applicable to runs already paid for. |
| 4 | The dependency order contradicted itself: the fleet README says the harness blocks every scorer while the table runs this after the format alone. | **Moot.** The harness merged during this review. This builds against the merged cell record rather than against an assumption about it. |
| 5 | The reuse target cannot supply what is needed: `verifyCitations` discards bodies, `safeFetch` exposes no truncation flag, and its request headers are hardcoded, so a registry needing a polite-pool identity could not be addressed. | **Accepted in part, and one half disproved.** Truncation is real and matters, because "the page does not contain the number" and "we stopped reading before the number" are different findings; `safeFetch` gains one additive flag. The header half is **rejected on evidence**: the polite pool is reachable through a query parameter, verified 27 July as `x-api-pool: polite-single` with the advertised limit doubling from five a second to ten, so the hardcoded identity stays untouched. Page text comes from `safeFetch` directly, which is the same fetcher rather than a second one. |
| 6 | A disk cache alone does not guarantee one lookup per identifier under concurrency: two cells can miss together, and per-worker delays can jointly breach a rate limit. | **Accepted.** Keys are namespaced by registry, writes are atomic, reads are schema-parsed, and a shared limiter plus in-process single-flight means concurrent misses collapse onto one request. Cross-process locking is deliberately **out of scope** and said so: the harness is one process, and inventing a lock for a case that does not arise is the speculative abstraction `CLAUDE.md` forbids. |
| 7 | The registry adapters were not implementable without fresh guesses: the deciding directory was unnamed, and the odd success envelopes had no parsing contract. | **Accepted.** A table per identifier type now carries grammar, canonical form, endpoint, the exact present, absent and not-checked predicates, and how each lands in a denominator. |
| 8 | "Numerals, percentages, proper nouns and years" is not yet an algorithm. | **Accepted.** The tokeniser, the normalisation and the verdict rule are pinned, including the case where a claim yields no checkable token at all. |
| 9 | "Contains that anchor" is not checkable across every fragment form, and treating every non-match as dishonest would manufacture accusations. | **Accepted.** Scoped to decoded HTML `id` and `name` anchors on a complete, readable HTML response. Every other fragment form is not-applicable or not-checked, never dishonest. |
| 10 | The acceptance criteria covered three outcomes out of a much larger surface, and a live lookup is neither hermetic nor stable. | **Accepted.** Every gate test runs against an injected transport, an injected clock and a temporary directory. Live probes stay outside the gate. |

The reviewer also confirmed as sound: the SSRF and redirect protection on the existing fetch path, the not-checked rule and its exclusion from the denominator, the refusal to cache a transient failure, the book-catalogue caveat, and keeping accuracy separate from volume.

### The shape this settles on

Two halves, and the split is the point.

- **A collector** that touches the network. It walks a report, pulls out every identifier and every cited address, asks each registry once per identifier through an on-disk cache, fetches each cited page once, and writes one timestamped evidence snapshot. Nothing here decides a score.
- **A scorer** that is pure and synchronous, in the same tree as its three sibling scorers, over the report text and that snapshot. Same inputs, same numbers, on any machine, in six months, with the network unplugged.

That separation is what makes a metric added in three months applicable to runs already paid for, which is the design of record's own reason for storing raw reports in the first place.

## Plan

[plan-BENCH-03.md](../plans/plan-BENCH-03.md) — Standard tier, 12 steps, 49 acceptance criteria. Its cross-family plan review returned MATERIAL DEFECTS over fourteen findings, four of them real bugs; the dispositions are in the plan's own gate note.

---

## Progress — 2026-07-27

**Branch:** `ai/bench-03` (local, based on `main` at `7fdd600`, **not rebased, not merged and not pushed, by instruction**; worktree `.worktrees/BENCH-03`). Fifteen commits.

**What shipped.** Two halves, as the plan settled on after the first cross-family review.

`bench/src/citations/` reaches the network: five registry adapters, an on-disk answer cache, a shared rate limiter, an in-process single-flight map, two live fetch adapters over the existing `safeFetch`, and an atomic evidence-snapshot store. `bench/src/score/` is pure and synchronous: identifier extraction, token containment and anchor honesty, the published statement-by-source algebra, and the scorer that assembles them over a report and a snapshot. `docs/bench/citation-integrity.md` carries the registry table, the dated live findings and what each number cannot mean.

One file in `src/` changed. `judgeCitationStatus` and `judgeCitationError` were extracted unchanged from the private `verifyOne` in `src/research/citations.ts` and exported, so the benchmark reads an HTTP status the same way the product does. Two implementations of one rule eventually disagree about what a 403 means, and this slice is otherwise at pains to avoid exactly that.

**What the live registries changed.** All five were checked against the real services rather than their documentation, and three do not behave as the brief assumed. Crossref alone would report a genuine reference as fabricated, because it is one DOI registration agency of several and a real Zenodo DOI is a 404 there and a 200 at the global handle directory. The book catalogue answers found for a fabricated number, because it is community-edited and really does hold a record listing it. arXiv refused every lookup across seven minutes with a 429, which makes `unchecked` the ordinary answer from that archive rather than the rare one. Two more answer HTTP 200 for something that does not exist. Reading any of those from documentation would have shipped a false accusation.

**Verification.** `npm run gate` green **twice**: 1218 tests passed, 2 skipped, 53 files, on both runs. Plus the protocol-level stdio smoke against the built `dist/index.js`: `initialize` returned `dossier 0.9.0`, `tools/list` returned 36 tools including the whole citation surface, and `research_plan` returned 9527 characters with no non-JSON on stdout. `bench/` is not compiled into `dist/`, so the smoke is a regression check on the one `src/` file this touched. No test in the gate makes a network call; every registry, page fetch, clock and directory is injected.

**Codex lane.** All three out-of-family gates ran at `max` effort, read-only, with no downgrade.

- **Spec review (R1):** MATERIAL DEFECTS, ten findings. Seven accepted, two accepted in part, one made moot by a merge. The largest, accepted, split network collection from pure scoring; one was rejected on evidence, since Crossref's polite pool is reachable through a query parameter and `safeFetch`'s hardcoded identity did not need widening.
- **Plan review (R1):** MATERIAL DEFECTS, fourteen findings. Twelve accepted, one in part, one rejected on evidence. **Four were real bugs and two of those were in the metric algebra**: necessity was being computed over the citation matrix where the paper computes it over the factual-support matrix, and an `unchecked` support cell was lowering citation accuracy exactly as a wrong citation would, which is the slice's own first rule inverted. Full dispositions in the plan's gate note.
- **Completeness critic (R2):** see below.

**Defects found by this item's own work, beyond the reviews.** A NUL byte in a template literal in `identifiers.ts`, which compiled, typechecked and linted clean while making the file binary to git and every `grep` for its contents return nothing; caught by `npm run lint:source`, which exists for exactly the v0.2.1 defect it repeated. A first reading of the necessity term that returns zero necessary sources whenever every statement is matched, killed by a two-statement worked example before it could ship. A bare-citation-row threshold generous enough to file an ordinary sentence carrying one link as a bibliography entry.

**Deliberate gaps, named rather than left to be discovered.** No cross-process lock on the answer cache, because the harness is one process. Live registry probes are a manual step and never in the gate. `relevantStatements`, `oneSidedAnswer` and `overconfidentAnswer` are reported unavailable with a reason rather than approximated. `sourceNecessity` is reproducible but not canonical, and says so on every result. Nothing in the product calls the new surface yet: BENCH-08 owns reporting and BENCH-10 owns the detector eval, so the exports are producer-less on purpose.

