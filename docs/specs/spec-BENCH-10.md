# BENCH-10: Self-eval of Dossier's own checking

**ID:** BENCH-10
**Status:** In Review
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-10](../features-to-triage/BENCH-10-self-eval.md) · **Design of record:** [benchmark.md](../plan/benchmark.md) · **Prior art:** [benchmark-prior-art.md](../deep-research/benchmark-prior-art.md) · **Depends on:** [BENCH-03](spec-BENCH-03.md)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-10-self-eval.md`.)*

# BENCH-10: does Dossier's own checking actually work

## Why this is a different kind of eval

Every other brief measures research quality. This one measures a detector, and it cannot use the same method.

`research_verify_citations` and `research_verify_claims` claim to catch a bad citation. Testing that needs a labelled corpus where the answer is already known: real pages paired with claims that are genuinely supported, partially supported, contradicted, or simply not addressed. The score is a confusion matrix, not a quality score.

Without that ground truth you can only measure whether the verifier is confident, not whether it is right.

## What to build

- A labelled corpus under `bench/detector/`: `{ claim, url, label }` where label is the four verdicts plus `unreadable`.
- Cases constructed deliberately, including the hard ones: a page about the right topic that does not contain the claim (the `not_addressed` case that link-checking cannot see), a page that contradicts it, a page behind a cookie wall.
- Precision and recall per verdict, and the confusion matrix in full. Aggregate accuracy hides the failure that matters, which is `not_addressed` being scored as `supports`.

## Both modes, compared

`research_verify_claims` runs either with a model judging or with the caller judging. Both should be scored against the same corpus, because the honest question is not whether the model mode is good but whether it is better than free.

## Why this is the most valuable artefact here

It is the only part of the benchmark that tests Dossier's own claim rather than a provider's. Everything else could be run by anyone against any tool; this measures whether the thing this product is for actually works.

## Acceptance

- The corpus is balanced enough that a detector answering `supports` to everything scores badly, and that is asserted by a test.
- Every case records why it was labelled as it was, so a disputed label is adjudicated against reasoning rather than against authority.

### Fleet context carried with the brief

- The governing rule for the whole benchmark: **no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run.
- **Eight items merged before this one.** BENCH-03 is the one being tested: it built `bench/src/citations/` and `bench/src/score/citations.ts`.
- BENCH-03 probed all five registries live and three do not behave as documented. Crossref alone would call a genuine DOI fabricated, OpenLibrary answers found for a fabricated ISBN, and arXiv rate-limited every probe across seven minutes. **The corpus must not assume a registry answer is available; it must carry cases where `unchecked` is the correct label and assert the detector says so rather than guessing.**
- Verification is `npm run gate` plus a stdio smoke against `dist/index.js`. No Playwright, no UI.

## Grounding: what already exists

Read before designing, and every claim below verified against the merged tree rather than assumed.

| Thing | Where | What it gives this slice |
|---|---|---|
| The five product verdicts | `src/ai/utility.ts` `SupportSchema` | `supports` · `partially_supports` · `contradicts` · `not_addressed` · `unreadable`. This is the label vocabulary; it is not invented here. |
| The judged mode | `src/ai/utility.ts` `judgeSupport(claim, sourceText)` | The model arm under test. Returns one of the five, plus an optional deciding quote. |
| The caller mode | `src/server.ts` `research_verify_claims` | Fetches each cited page and hands the text back for the caller to judge. Its own free, deterministic sibling is containment. |
| Containment | `bench/src/score/containment.ts` | `supported` · `unsupported` · `unchecked` over a statement and a page snapshot. The free arm. |
| Link checking | `src/research/citations.ts` `judgeCitationStatus` / `judgeCitationError` | What `research_verify_citations` decides: `live` · `not_found` · `blocked` · `unreachable` · `unverified` · `invalid_url`. |
| The two oracles, already shaped for this | `bench/src/score/citations.ts` `containmentOracle` / `judgedOracle` | BENCH-03 shipped `judgedOracle` as a lookup over recorded verdicts precisely so this slice can score the two without putting a model in a synchronous scorer. |
| Evidence collection | `bench/src/citations/collect.ts` `collectCitationEvidence` | Produces a `PageEvidence` through the real production path: SSRF-safe fetch, `extractText`, `collectAnchors`, `judgeCitationStatus`. The corpus captures pages through it rather than through a second fetcher. |
| Registry decisions | `bench/src/citations/registries.ts` `plan()` + the loop in `collect.ts` | The detector under test for the registry family. Every non-answer must be `unchecked`. |

## Requirements

### R1 — The corpus is a frozen snapshot, and says so

Every support case carries the page text as captured, not a live URL to re-fetch at scoring time. Three reasons, in order:

1. `docs/plan/benchmark.md` stores raw reports so a metric added later can be applied to research already paid for. A corpus that re-fetched would score differently every week and could never do that.
2. The gate has no network. A corpus that needed one could not be a regression suite.
3. The prior art is explicit that live-web evaluation is not reproducible, which is why RetroSearch and BrowseComp-Plus exist.

The cost is that the corpus has a shelf life, and the honest move is to stamp it: every page records where it came from, when it was captured, and the SHA-256 of the text. The loader recomputes that digest and **fails the load** if it disagrees, so a hand-edited fixture cannot silently change a score.

### R2 — Every case records why

`why` is required, minimum 40 characters, and is the field a dispute is settled against. A label with no reasoning is an assertion of authority, which is the thing this whole benchmark is against.

### R3 — Balance punishes the degenerate strategy

`supports` is a minority of the corpus, every label carries at least three cases, and no label exceeds 35% of it. A detector answering `supports` to everything then scores near its own share and macro-F1 near zero, and a test asserts exactly that against the real corpus rather than a fixture.

### R4 — Both modes, one corpus, one report

Containment and the judged mode are scored over identical cases. The judged mode's verdicts are **recorded by a manual pass and stored**, never called from the scorer: a model call is asynchronous, non-deterministic and costs money, and a scorer with any of those three properties cannot be re-run. This is the same split BENCH-03 made between collection and scoring, for the same reason.

### R5 — Abstention is declared, not folded away

Every arm may decline to answer. Precision and recall are reported over the cases an arm **committed** to, coverage is reported beside them, and a second recall over every case (abstention counted as a miss) is reported as well. The prior art is specific that the three common ways of handling abstention answer different questions and are not interchangeable preprocessing, so all three numbers are named rather than one being chosen silently.

### R6 — What an arm cannot express is a declared ceiling, not a failure it made

Containment has no vocabulary for `contradicts` or `partially_supports`. Reporting recall 0 on those without saying why would read as a tuning problem. Each arm declares which labels it can emit, and the result marks the rest `inexpressible`.

### R7 — `unchecked` is a correct answer and is asserted as one

The registry family carries cases whose transport answers 429, 500, a timeout and an unparseable body. The correct label for every one is `unchecked`, and the test asserts the detector says so rather than reaching `absent`. This is BENCH-03's first rule, tested from the outside.

### R8 — Nothing here spends money in the gate

The capture pass and the judged pass are manual CLI steps, like BENCH-09's fail-check and BENCH-03's live registry probes. `npm run gate` scores a corpus already on disk, offline.

## Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | A labelled corpus exists under `bench/detector/` over all five support verdicts, plus a registry family over `present`/`absent`/`unchecked`/`invalid`. |
| AC-2 | It contains a page about the right topic that does not contain the claim, a page that contradicts the claim, and a page behind a wall. |
| AC-3 | The full confusion matrix and per-verdict precision and recall are produced for every arm. |
| AC-4 | Containment and the judged mode are scored against the same cases and the gap is reported as a number. |
| AC-5 | A detector answering `supports` to everything scores badly, asserted by a test against the real corpus. |
| AC-6 | Every case carries a `why`, enforced by the schema. |
| AC-7 | A registry that could not be reached is scored `unchecked`, never `absent`, asserted per failure mode. |
| AC-8 | The corpus loads with no network, and a tampered page fixture fails the load. |
| AC-9 | Link checking's blindness to `not_addressed` is reported as a count, not as prose. |

## Non-goals

- No model in the scoring loop. The judged arm is the **subject**, never the judge.
- No live fetch at scoring time.
- No attempt to improve containment. Measuring the weakness is the job; tuning it away would destroy the measurement.
- No new MCP tool. This is benchmark code and is not compiled into `dist/`.

## Assumptions carried forward

1. **The five-verdict vocabulary is the product's, and is taken as given.** It is what `research_verify_claims` already asks a caller for, so a corpus in any other vocabulary would measure something the product does not do.
2. **Constructed page fixtures are legitimate where a captured one cannot be held still**, and are marked `constructed` so the distinction is visible in the corpus rather than in a commit message.
3. **A page is captured once, and several claims are written against it.** The same real page yielding `supports` for one claim and `not_addressed` for another is the discrimination being measured, and authoring it that way makes the corpus harder rather than easier.

## Progress

**Delivered 27 to 28 July 2026.** `bench/detector/` holds 30 support cases and 18 registry cases; `bench/src/detector/` holds the loader, the projections, the arithmetic, the arms, the report and the two manual passes. `npm run bench:detector` scores it offline. Full method and results in [`docs/bench/detector-eval.md`](../bench/detector-eval.md).

### What it found

**The free path is weaker than the docs implied.** Token containment answered `supports` for **11 of the 23 citations a reader would call bad**: all six whose claim was stronger than the page supported, four of the seven the page contradicts outright, and one the page never addresses. Five-class accuracy over the cases it answered is 30.8% against 23.3% for a detector that answers `supports` to everything.

The cause is structural rather than tunable, which is why it is reported rather than fixed. A contradiction and an overstatement both use the page's own numbers and names, so a check asking whether those tokens appear has nothing to look at. `semver-prerelease-higher-precedence` asserts the exact opposite of a sentence on the page, and every token it carries is on that page.

**The judged mode is much better.** Over the same 30 cases: 80.0% five-class, 96.2% binary, **zero** bad citations waved through, recall 1.00 on `contradicts` and on `unreadable`. Paired: both right on 5, only the judged mode right on 19, only containment right on 3, both wrong on 3. Containment stays the default because the governing rule forbids a model in the scoring loop, and the price of that choice is now a number.

**Link checking is blind here by construction, and that is now a count.** 22 of 30 cited pages resolve with HTTP 200 and do not support their claim. Three of the four walls are served with HTTP 200, and no status code can see any of them. In the binary view, treating a resolving link as a sound citation scores **identically to answering `supports` to everything**.

**The registry family scored 18 of 18**, including all six cases whose correct answer is `unchecked`. Zero were scored `absent`.

### Every acceptance criterion

| # | Where it is met |
|---|---|
| AC-1 | `bench/detector/support` (5 verdicts) and `bench/detector/registry` (4) |
| AC-2 | `rfc6265-samesite`, `semver-prerelease-higher-precedence`, `consent-wall-quarterly-figures`; asserted by `balance.test.ts` |
| AC-3 | `confusion.ts`, rendered per arm by `report.ts` |
| AC-4 | `armGap` over identical cases; the gap is printed case by case |
| AC-5 | `balance.test.ts` runs the degenerate arm over the corpus that ships |
| AC-6 | `why` is `z.string().min(40)` in `schema.ts` |
| AC-7 | six `unchecked` cases across six failure modes; `uncheckedScoredAbsent` asserted zero |
| AC-8 | the loader recomputes every digest and fails the load on a mismatch |
| AC-9 | `liveButUnsound`, printed as a count and a share |

### Three things worth carrying forward

**The corpus is a snapshot with a shelf life, and it is stamped.** Every fixture records its origin, its date and its SHA-256. That is what makes the eval reproducible and what the prior art says a live-web one can never be. It also means a re-capture is a deliberate act with a visible diff.

**One case had to be edited after capture and says so.** The live ScienceDirect 403 echoes the requesting IP address and a Cloudflare reference number back at the caller. Both were removed and the fixture is marked `constructed` with the reason, rather than committing somebody's IP address to a public repository or quietly redacting a page still labelled `captured`.

**The judged arm was run through a coding CLI, not the product's own utility model.** It spends a subscription already paid for rather than a metered balance, which is the routing rule the product itself follows and how BENCH-09 fail-checked 27 tasks for nothing. The number therefore measures a model of that class answering the product's own question, with the product's own prompt and page cap. The evidence file records which model answered and on what date.

### Two defects the gate found in this slice's own code

**A NUL byte, used as a map-key separator in `confusion.ts`.** It compiled, it passed eslint, and 117 tests passed over it. `npm run lint:source` caught it, which is the same class of defect as the v0.2.1 one that lint exists for. Replaced with a nested map, which removes the separator question rather than answering it.

Worth flagging beyond this slice: **BENCH-08 hit the identical defect on the same day** (`0744b77`, "a NUL byte separated two grouping keys, caught by the source-hygiene lint"). Two independent runners producing a U+0000 separator in a composite map key, hours apart, is a pattern rather than a coincidence, and the source-hygiene lint is the only thing in the toolchain that sees it.

**The judged answer was narrowed by hand rather than Zod-parsed.** Model output is a trust boundary and CP §1 is explicit about it. Now parsed through a Zod enum, which is also what refuses a sixth verdict.

### Verification

`npm run gate` twice on the rebased branch: 85 files, 1991 tests passing, 2 skipped. Plus the stdio smoke against `dist/index.js`: initialize, `tools/list` (37 tools), `research_plan`, `resources/list`, with stdout carrying only JSON-RPC.

The wiring is proved by `cli.test.ts`, which spawns the real entry point over its real argv rather than importing a handler. A module with passing tests that nothing calls is a defect this repo has already shipped once, and an import-based test cannot tell the two apart.
