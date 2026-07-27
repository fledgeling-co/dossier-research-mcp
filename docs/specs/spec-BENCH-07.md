# BENCH-07: Source quality, independence and syndication

**ID:** BENCH-07
**Status:** Triage
**Created:** 2026-07-27
**Last updated:** 2026-07-27
**Brief:** [BENCH-07](../features-to-triage/BENCH-07-source-quality.md) · **Design of record:** [benchmark.md](../plan/benchmark.md)

## Feature description

*(Verbatim from `docs/features-to-triage/BENCH-07-source-quality.md`.)*

# BENCH-07: source quality, independence and syndication

## What already exists

`classifySource` for the official, academic, journalism and community mix. `registrableDomain` for independent-domain counting. `assessSupport` for counting independent domains. Reuse all three; do not reimplement.

**Correction from BENCH-01, verified:** an earlier draft of this brief named `countsAsCorroboration` as the domain counter. It is not; it only filters a user's own documents out of independent corroboration. `assessSupport` is the one that counts domains.

## What is new: syndication detection

Four domains carrying the same wire story are one source wearing four hats, and independent-domain counting cannot see it. Detect by shingled hashing of fetched page text, and report the collapsed count alongside the raw one.

Both numbers are reported, never just the collapsed one. The shingle threshold is a judgement and a reader who disagrees with it needs the raw figure to reason from.

## Threshold warning

An earlier attempt at near-duplicate merging in `src/research/corroborate.ts` was rejected because published thresholds around 0.7 are tuned for article bodies and would silently collapse genuine corroboration between short claims. That objection does not apply here, because this operates on full fetched page text, which is what those thresholds were tuned for. Say so in the code, or someone will apply the earlier objection to the wrong thing.

## Acceptance

- Four copies of one wire story collapse to one source; four genuinely independent articles on the same event do not.
- The threshold is a named constant with its provenance in a comment.

### Fleet context carried with the brief

- The governing rule for the whole benchmark: **no model in the scoring loop.** Every score is computed by code from a gold set fixed before the run.
- BENCH-01 is merged. Reuse its code rather than reimplementing it.
- Shared surfaces are append-only: acceptance rows into `docs/test-plan.md` before the tests, one entry under `## [Unreleased]` in `CHANGELOG.md`, one ledger row. Never reorder another item's rows.
- Verification is `npm run gate` plus a protocol-level stdio smoke check, and the suite is run twice. There is no user interface and no browser test.

---

## Triage — 2026-07-27

**Ready for Implementation Plan**

**Sentinel review:** S1 — Approve with assumptions

*(No UI preview section: this repo has no user interface and no design system. Nothing customer-facing changes; the whole item is behind the scenes.)*

**Where it shows up**

- Nothing customer-facing changes. Nobody using the research product sees anything new, and no money is spent by anything added here.
- The people affected are whoever reads a benchmark result and wants to know whether a backend's forty citations were forty sources or four sources wearing forty hats.
- It joins the set of measures already built rather than starting a second one beside it, and it is reported the same way they are: a measure that cannot be taken says so, and never reports a zero instead.

**Behaviour changes**

- A finished report's citations are graded into the same buckets the product already uses: official, academic, news, industry commentary, community, and unrecognised. The buckets and the rules behind them are the existing ones, not a second opinion invented here.
- The count of genuinely separate sources behind a report is reported **twice**: once as the plain count of separate publishers, and once after pages carrying the same underlying story have been merged into one. Both numbers always appear together. The merged number is never shown on its own, because the rule that produces it is a judgement and a reader who disagrees with it needs the plain number to reason from.
- Whether two pages carry the same story is decided by comparing long runs of words shared between them. Two pages count as the same story when they share enough of their wording, or when one is wholly contained in the other, which is what a shortened republication of a wire story looks like.
- Pages that were never fetched, and pages too short to judge, are never merged and are **listed by name** in the result. A merged number that quietly means "we checked some of them" would be worse than no merged number at all.
- Nothing here fetches anything. The page text is handed in already collected, so the same result is produced twice from the same input on any machine, and no test can reach the network.

**Assumptions**

- `[Data & scope]` The merged count and the plain count are both reported, always, and the merged one is never reported alone. *(explicitly required by the brief; the merging rule is a judgement.)*
- `[Data & scope]` Two pages are the same story when the share of long word-runs they have in common passes a stated bar, written as a named constant with where the number came from. *(the brief's acceptance criterion.)*
- `[Data & scope]` The run length and the bar are both anchored to published work that was read and quoted rather than recalled, and the part that is this project's own judgement rather than a published figure is labelled as such. *(the repo's standing rule that a claim is dated and sourced or it is not made.)*
- `[Operations]` A measure that cannot be taken reports that it cannot be taken, and never a zero. *(the shape the measures already built use; a zero and an unmeasurable read identically in an average and mean opposite things.)*
- `[Data & scope]` A second, stricter bar catches a shortened republication, where one page is wholly inside another. *(a shortened wire story is the ordinary shape of republication and the first bar alone cannot see it, because a half-length copy can never share more than about half its wording.)*
- `[Data & scope]` A page below a stated length is never compared. *(a paywall notice, a cookie wall and a not-found page are near-identical everywhere, and merging two of those would silently understate independence on the strength of two error pages.)*
- `[Data & scope]` Merging is transitive: if the first and second pages match, and the second and third match, all three are one source. *(a wire story reaches a chain of outlets, and treating the chain as two separate pairs would count it twice.)*
- `[Data & scope]` Anything cited that is not a real web address is discarded before counting. *(model output arrives with "unknown" and "not available" among the links, and the product already learned that counting those makes a claim look corroborated by three admissions that there was no source.)*
- `[Operations]` The plain count of separate publishers comes from the product's existing counter rather than a second one written here, and a test pins the two together so they cannot drift. *(two implementations of one rule eventually disagree about what the rule is.)*
- `[Operations]` No single blended quality number is produced. *(the prior art is explicit that blending how many sources a report cited with how good they were hides the very failure this is measuring; the parts are reported separately.)*
- `[Operations]` The page text is supplied by the caller; nothing here fetches. *(keeps the result repeatable and keeps every test off the network, matching how the task format was built.)*
- `[Operations]` The comparison works on words, lowercased, with punctuation removed and numbers kept whole. *(numbers are the strongest signal that two pages carry the same story.)*
- `[Experience]` The reason the earlier objection to this technique does not apply is written beside the constant itself. *(explicitly required by the brief, and the next reader will otherwise reapply it to the wrong thing.)*
- `[Experience]` No benchmark tasks are authored here beyond test material. *(the corpus is its own item.)*

*If any of these are wrong, edit it inline (or correct an assumption) in this file and re-run `/triage BENCH-07` before the planner picks this up.*

**Findings carried to the planner**

- *Medium, Engineering Readiness.* The brief says "fetched page text" without saying who fetches it or who turns a web page into text. The product does have a routine that strips a page down to text, but it is private to one large file and nothing outside that file can reach it. This item therefore takes text as given, and the gap — that whoever collects the pages needs that routine and will have to lift it out — is recorded for the run-harness item rather than solved by reaching into the product's own file to serve the benchmark.
- *Medium, Product Logic.* The plain count and the merged count are both counts of publishers, so they can only ever be compared if both are computed over the same set of links. Discarding non-links has to happen once, before either count, or the two numbers describe different populations and the difference between them stops meaning anything.
- *Low, Operational.* The product already carries a crude same-story detector that compares the wording of short claims rather than pages. It stays exactly as it is. The two are different instruments answering different questions on different inputs, and the note beside the new one says so, because that is the confusion the brief predicts.
- *Low, Operational.* The written explanation of what the measures mean is one file whose title lists the three measures already built. Rather than rewrite another item's title, this one gets its own written explanation beside it, which is also how the task format and the run harness are already documented.

**Codex cross-family spec review — 2026-07-27**

Reviewer: `gpt-5.6-sol` at `max` effort, read-only, grounded in the repository. Verdict as returned: **MATERIAL DEFECTS**, six findings. All six were accepted; none was rejected. Two of them changed what gets built rather than only what is written down.

1. *Accepted, and it changed the design.* **The two counts had no defined common unit.** One is a count of publishers and the other is arrived at by comparing pages, and a publisher can contribute more than one page. Where a publisher ran both somebody else's story and its own, page-level and publisher-level answers differ, and both were consistent with the acceptance examples as written. The rule is now stated: two publishers merge when any page on one is the same story as any page on the other, publishers are what get counted, and the case where that understates independence is named in the result rather than left for a reader to discover. A worked example of exactly that case is now part of the acceptance.

2. *Accepted, and it changed the scope statement.* **Nothing currently keeps the page text this needs.** The run harness records the report, what it cost and how long it took; the product's own claim-checking tool fetches page text and keeps only whether the fetch worked. So this measure cannot both refuse to fetch and be re-computable from a stored run, today. It is therefore declared **producer-less by design**: complete, tested and callable, with the missing durable record of a fetched page named as belonging to the harness or to the citation item. Recorded rather than half-built.

3. *Accepted.* **The stated reason for the bar did not match the evidence in this repository.** The only recorded precedent for the number measures something different from what this measures, so the number transfers as a considered value and not as a calibration. The written reasoning now says exactly that, names all three anchors it rests on, labels the part that is this project's judgement, and the acceptance now checks the decision immediately below, exactly at, and immediately above every bar rather than only in the middle of the range.

4. *Accepted.* **The governing design document still named the wrong existing function** as the one that counts publishers, which is the very error this item's brief was written to correct. Corrected in the design document itself, dated, with what the misnamed function actually does.

5. *Accepted.* **The acceptance was two lines and the behaviour is twenty.** It now covers the mixed publisher, the unusable citation, the same page cited four ways, the chain of republication, the page nobody supplied, the page too short to judge, and the page nobody looked at, each with its own row.

6. *Accepted.* **Caller-supplied text had no bound.** Comparison is pairwise, so an oversized input turns a cheap check into an expensive one. There are now stated ceilings on both the length of a page and the number of pages, and crossing either is **reported**: a page compared on part of itself, or never looked at, is never allowed to read as one that was fully examined.

*If any of these dispositions are wrong, edit them inline here and re-run `/triage BENCH-07`.*

## Plan — 2026-07-27

Implementation plan: [`docs/plans/plan-BENCH-07.md`](../plans/plan-BENCH-07.md) (Plan size: Standard).

## Progress — 2026-07-27

**Implementation Complete (local branch, not merged, not pushed)**

**Summary:** `bench/src/score/` gains the source-quality axis. It grades a report's cited sources with the product's own classifier, counts the independent registrable domains behind them with the product's own counter, and then detects the syndication that counting domains cannot see, by shingled hashing of fetched page text. Both counts are reported together and the collapsed one is never reported alone.

**Branch:** `ai/bench-07` (local, based on `main` at `7fdd600`, **not rebased and not merged by instruction**; worktree `.worktrees/BENCH-07`).

**Built by slice:**
- `bench/src/score/syndication.ts`: the near-duplicate primitive. Tokenise, ten-word shingle, hash, compare by resemblance and by containment. Every threshold is an exported constant carrying its provenance, and the constant that will be objected to carries the objection and why it does not apply.
- `bench/src/score/source-quality.ts`: the scorer. One filter for unusable citations, run before either count so both describe one population; `classifySource` and `profileEvidence` for the mix; `assessSupport` for the raw domain count; union-find over domains for the collapse; every page and domain it could not check named in the result.
- `bench/src/score/wire-fixtures.ts`: the two fixture families, written as real news prose about one event because repeated filler has a degenerate shingle set and would pass a detector that does not work.
- Tests: 61 across two files, traced to `SRCQ-01` through `SRCQ-23` in `docs/test-plan.md`.
- Docs: `docs/bench/source-quality.md`, a pointer to it from `docs/bench/scoring.md`, the two `bench/` lines in `CLAUDE.md`, a CHANGELOG entry, and the correction to `docs/plan/benchmark.md` section 7.

**Reachability:** BENCH-07 adds **no MCP surface and no user-facing capability**, so there is no UI hop to trace. Its exported surface is declared **producer-less by design**, and the reason is a finding rather than an omission: nothing in the repo currently persists fetched page text. The run harness stores the report path, the cost and the timing; `research_verify_claims` fetches page text and persists only whether the fetch succeeded. The durable citation snapshot this scorer wants belongs to the harness or to the citation-integrity item and is recorded in `docs/bench/source-quality.md` rather than half-built here. What is wired today: `syndication.ts` into `source-quality.ts` into the `bench/src/score/index.ts` barrel, each exercised by tests that run the real code, plus a real-Node run through the barrel outside the test transform.

**Clause coverage:** every plan acceptance criterion is ticked and carries a named test, except the one that is a gate result rather than a code property. The threshold-provenance clause is satisfied by the comment and by the exported-constant test; the comment's own wording is prose and is not asserted by a test, which is stated rather than glossed.

**Two defects found by exercising rather than reading**, both fixed here:
- A page arriving past the page ceiling was reported as unchecked with the reason "no page text was supplied for this domain", which is false and sends whoever reads it to the harness instead of to this file's own bound. Each of the three reasons is now distinct.
- Every clustering test had exactly one cluster, so a link filter that handed every link to every cluster would have passed all of them. A two-cluster fixture now distinguishes a correct attribution from a plausible wrong one. The implementation was correct; the check was not.

**Implementation assumptions:**
- The integration branch is **local `main`**, matching BENCH-01.
- The spec, the plan, the AC rows and the design-of-record correction are committed **on the branch**, and the main working tree was restored to exactly the state the other live runners expect.
- No task files are authored here beyond test fixtures.

**Dropped or changed vs spec/plan:** nothing dropped. Two things added beyond the plan, both from the cross-family review: the containment rule's second threshold was already planned, but the two resource ceilings and the reporting of every case where they bite were not, and the rule mapping page clusters back to domain counts was implicit in the plan and is now stated in the code and tested.

**Gates (actually run, on the final tree):**
- `npm run gate` exit 0, **twice consecutively**: typecheck, lint, lint:source, lint:docs, test:all, build.
- `npm pack --dry-run`: zero `bench/` and zero `dist/bench/` entries.
- Real-Node out-of-transform run through the barrel: four printings of one wire story report 4 raw and 1 collapsed; four independent articles report 4 and 4.
- stdio smoke against `dist/index.js`: initialize ok, `tools/list` returns 36 tools, `research_plan` answers with no credentials, zero non-JSON lines on stdout. A regression check, since this item adds no MCP surface.

