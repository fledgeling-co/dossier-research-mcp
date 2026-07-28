# Dossier benchmark

**Status:** design, 27 July 2026. Not built. A deep-research panel of seven backends is running on prior art and will amend this.

---

## What is being measured, and why it is three things

1. **Each backend on its own.** Every CLI, every API, every variant. What each is good and bad at, per category.
2. **Dossier with no backend at all**, running the free local loop over ordinary web search. This is the honest control: if the loop with no API keys scores close to a paid backend, that is the finding.
3. **Dossier's own checking.** Whether `research_verify_citations` and `research_verify_claims` actually catch a bad citation. This is a different kind of eval and is treated as one below.

## The governing constraint: no model in the scoring loop

Every score must be computed by code, from a gold set fixed before the run.

This is not fastidiousness. An LLM judge is non-deterministic, costs money per task per backend per repetition, and is circular: it uses the class of system under test to grade the system under test, so a failure mode shared by judge and subject is invisible by construction. A benchmark that cannot be re-run cheaply will be run once, published, and quietly rot.

The cost is paid once, in task authoring. **A task is only admitted to the suite if its correct answer can be checked by a string, a number, a set membership or an HTTP request.** That rule is what makes everything below possible, and it is the whole design.

## How each category is checked without a model

### 1. Accuracy

Gold facts, extracted from a primary source by a human at authoring time, each a number, date, name or identifier.

Scoring: normalised exact match. Numbers compared with a tolerance the author sets per fact (a revenue figure to 3 significant figures, a version string exactly). Dates parsed and compared as dates. Names matched case-insensitively after Unicode normalisation.

A task carries between one and ten gold facts. The score is the share recovered.

### 2. Relevance

The naive version needs a judge. The programmatic version does not: at authoring time, record the **required terms** a competent answer cannot avoid using, and the **forbidden drift terms** that indicate the answer wandered into an adjacent topic.

Scoring: required-term coverage minus drift penalty. Crude, but it separates an answer about the right subject from one that is not, which is all this category needs to do. Accuracy handles whether it is correct.

### 3. Validity, meaning citation integrity

Four checks, all deterministic, in increasing strength:

- **Resolvability.** The URL returns 2xx. Already implemented in `src/research/citations.ts`.
- **Registry existence.** A DOI, an arXiv id, a PMID, an ISBN, a CVE, each checked against the registry that owns it.

  I wrote here that this was "programmatic hallucination detection ... caught exactly, with no judgement at all". **BENCH-03 probed all five registries live and that claim is wrong for three of them.** Corrected 27 July 2026 rather than quietly softened, because the overclaim is more instructive than the correction:

  - **Crossref alone would call a genuine reference fabricated.** It is one DOI registration agency among several. The real DOI `10.5281/zenodo.3509134` is a Crossref 404 and a handle-directory 200. Absence now rests on the global handle directory, not on one agency.
  - **OpenLibrary answers "found" for a fabricated ISBN**, since it really holds a record listing `9789999999991`. ISBN results are catalogue presence in both directions and prove nothing either way.
  - **arXiv rate-limited every probe across seven minutes**, which makes `unchecked` its ordinary answer rather than its exceptional one.
  - NCBI and NVD both return HTTP 200 for things that do not exist, so a status code is not an answer.

  What survives is still worth having and is narrower than advertised: a citation whose identifier the owning registry positively denies is strong evidence of fabrication, and everything else is `unchecked`. The instrument is sharp in one direction only.
- **Claim-token containment.** Extract the checkable tokens from the claim (numerals, percentages, proper nouns, years) and require them to appear in the fetched page text. This catches the common `not_addressed` failure, where a real page about the right topic simply does not contain the specific assertion, without asking a model whether it "supports" anything.
- **Anchor honesty.** A cited URL with a fragment must contain that anchor.

### 4. Viewpoint coverage, the due-weight category

The failure being measured: a genuine minority or dissenting position is dropped because the weight of published material sits on the other side. Call the failure consensus collapse.

Programmatic method: choose questions where a documented dissenting position exists at a **known URL or DOI**, recorded in the gold set at authoring time. Then check whether the report reached it.

Scoring, per task:
- **Dissent recall**: did the report cite the known dissenting source, or use its distinguishing term?
- **Conflict acknowledgement**: for tasks where two authoritative sources give different numbers, the gold set carries both. Did the report contain both figures, or explicitly flag the disagreement? Reporting one number as settled fact when two exist is the failure, and it is checkable by looking for the second number.
- **False-balance guard**, so this does not reward both-sidesing everything: a subset of tasks has a genuine settled answer and a documented fringe claim. Surfacing the fringe claim as though it were contested is penalised. Without this counterweight the metric rewards indiscriminate hedging.

### 5. Calibration

Dossier requires a confidence qualifier on every non-trivial claim. That makes calibration measurable: pair each stated confidence with whether the associated gold fact was recovered correctly, and compute a Brier score across the suite.

A backend that is right 60% of the time and says High every time is worse than one right 55% of the time whose Highs are right 90% of the time. Nothing else in the suite captures that.

### 6. Refusal correctness

Two task families where the correct answer is not an answer:

- **False premise.** The question presupposes an event that did not occur. Gold: the report must not assert it. Checked by searching for the fabricated entity or date as an assertion.
- **No public footprint.** A real but genuinely undocumented subject. Gold: the report says so. This is what Dossier's information black box exists for, and it is the only category where a long confident report is the worst possible outcome.

### 7. Source quality and independence

All existing code. `classifySource` for the official / academic / journalism / community mix, `registrableDomain` for domain identity, and `assessSupport` for the rule that agreement between backends is not corroboration, which it enforces by counting independent registrable domains after canonicalisation.

**Corrected 27 July 2026.** This section named `countsAsCorroboration` as the counter. It is not one: it takes a single classified source and returns whether that source is public enough to count at all, which is the rule that keeps a user's own documents out of independent corroboration. It counts nothing. BENCH-01 verified the error and BENCH-07 corrected it here rather than leaving the governing document contradicting the item built from it.

One addition: **syndication detection**, by shingled hashing of fetched page text. Four domains carrying the same wire story are one source wearing four hats, and independent-domain counting alone cannot see it.

### 8. Recency

Parse publication dates from sources, compare against the task's as-of horizon, weight by source type using the existing rule that a standard from 2019 is current while a benchmark from 2019 is not.

**Amended 28 July 2026.** Two things this line assumed did not exist. The weighting rule did not: `HORIZONS` in the product is keyed by source type alone, so a 2019 specification and a 2019 leaderboard graded identically, and BENCH-06 built the durability axis that separates them. Nor did the input: nothing recorded a publication date at all, which BENCH-08 discovered when it had to declare the whole dimension unavailable on every report. BENCH-16 closed that by reading a date from the page at fetch time, in [`../bench/citation-integrity.md`](../bench/citation-integrity.md).

The part worth carrying forward is what closing it measured. Over the benchmark's own corpus of cited URLs, **43 of 72 pages carry no publication-date signal of any kind**, and modification dates outnumber publication dates on the pages that carry anything. So recency here is computed over a minority of a technical corpus's sources, by construction, and the share that could not be dated is reported beside it. A design that had assumed "parse publication dates from sources" would work would have produced a confident number over whichever quarter of the corpus happened to be datable.

### 9. Cost and wall clock

Recorded per run. A backend that scores two points higher for six times the money is a finding, not a winner.

### 10. Variance

Every task run `n` times per backend, reported as median with spread rather than a single number. Deep research is non-deterministic and a single run per cell is a rank ordering of noise. `n = 5` is the target; `n = 3` is the floor at which a spread is reported at all.

## Task categories

Each carries gold facts and is checked by the machinery above.

| Category | What it separates |
|---|---|
| Time-bound | Enforced date windows from asked-for ones |
| Enumeration | Matrix completeness; every cell filled or explicitly marked unknown |
| Legal and regulatory | Precision and official-source reliance |
| Primary literature | Real DOIs, and reading past the abstract |
| Social and sentiment | The only category where X access matters |
| Technical | Issue trackers, changelogs, version specifics |
| Obscure entity | The black box; correctly reporting nothing found |
| False premise | Refusing a fabricated presupposition |
| Contested | Due weight, both numbers, dissent retention |
| Settled-with-fringe | The false-balance counterweight |

## Amended 27 July 2026, after reading the prior art

A seven-backend panel researched what already exists. The report is `../deep-research/benchmark-prior-art.md`, 49 sources, 48 of which resolve. Two decisions below were wrong and are corrected here rather than quietly edited.

**Wrong: build the harness shell.** promptfoo is TypeScript, ships daily, and already has multi-provider evals, custom JavaScript scorers returning `{pass, score, reason}`, custom aggregation and agent-trajectory assertions. Building a runner, a provider abstraction and a result store is months of undifferentiated work. Adopt the shell; the differentiated part was never the harness.

**Wrong: invent the metrics.** DeepTRACE (arXiv 2509.04499, ICLR 2026) specifies eight dimensions at formula level and separates **accuracy from thoroughness from necessity**, which is the distinction that catches over-citing. I verified the paper exists and is titled as cited. Adopting a published metric set also makes results comparable with everyone else's, which inventing one destroys.

**Right, and confirmed: build the citation scorer.** No harness in TypeScript, Rust or Go ships one. The algorithm is public.

**Missing entirely: the statistics.** The design had none, and the 2026 literature treats several as non-negotiable. Paired-difference tests with bootstrap confidence intervals. **Clustered standard errors when tasks share topics, which inflate naive errors up to threefold** and which this corpus walks straight into, being ten categories of ten related tasks. `k >= 3` repeats with `pass^k` reported beside `pass@1`. Completion rate as a validity metric. And **citation accuracy reported separately from citation volume**, since a backend citing a hundred sources at 80% is not the same product as one citing ten at 80%.

**Underpowered.** The design says a hundred tasks. The report's judgement is that every existing set is underpowered and that effort belongs in extending toward a thousand. Recorded rather than acted on, because a hundred well-authored tasks still beats a thousand thin ones, but the reader should know the target is low.

**One place the prior art and this design genuinely disagree.** DeepTRACE's support check uses a model judge. This design forbids a model in the scoring loop and uses token containment instead, which is weaker and exact. Both are kept: containment is the default because it is free and repeatable, the judged variant is available for anyone who wants it, and BENCH-10 scores the two against the same labelled corpus so the gap between them is measured rather than assumed.

## Rule 4 versus purpose 2, resolved 27 July 2026

BENCH-09 found these in conflict and was right to stop rather than pick.

Purpose 2 makes Dossier's free local loop the **control**, and asks whether it scores near a paid backend. Admission rule 4 says a task must be shown to fail before it is admitted. Read strictly, "must fail" means *no backend already passes*, which excludes every task the control passes and forces the control's score to zero by construction. The control would then measure nothing, and the answer to purpose 2 would be an artefact of the corpus rather than a finding.

**The rule means the task must not be saturated, not that every backend must fail it.** Admit a task when **at least one probed backend does not already pass**.

The reasoning: a task every backend passes measures nothing and cannot move, which is what rule 4 exists to prevent. A task some backends pass and others fail is the discriminating case, and discrimination is the entire point. Excluding it would throw away the only tasks that can produce a ranking.

BENCH-09 admitted on this reading. The stricter reading would have admitted four of its seven, and its evidence names which, so nothing needs re-running if this is ever revisited.

## What BENCH-09 established, which changes what a good task looks like

It authored 27 tasks anchored on immutable post-cutoff events, each cited to a machine-readable primary source at a stable URL, and verified every gold fact against the live source. Closed-book, **0 of 27 were answerable from model weights**, so the anchoring worked.

Search-enabled, **Claude Code already passed 23 of 27** and Codex passed 20 of those. The corpus was almost entirely saturated on arrival.

The cause is worth stating as a rule for whoever authors the next batch: **a single primary source at a stable URL is a lookup, not research.** An agent fetches `nodejs.org/dist/index.json` once and reads off four answers. Anchoring a fact so it cannot rot and anchoring it so it cannot be trivially retrieved are different problems, and solving only the first produces a corpus that measures fetching.

Two shapes survived, and they are the shapes to build on: **answers that are an absence**, and **fabricated premises**. Neither is retrievable from a single document, because there is no document to retrieve.

The prior art names the fix, LiveDRBench's problem inversion, and BENCH-09 did not apply it. That is the highest-value next step in the corpus, ahead of adding categories.
## Amended again 27 July 2026, by BENCH-02

Two corrections, both made visibly rather than by editing the text above into agreement with what shipped.

**Wrong: "a stale task is reported as stale rather than scored."** A stale task **loads, is scored, and is counted as stale**, which is what BENCH-01 implemented and what the honest limits section above now points at. Four reasons decided it, in this order.

Dropping stale tasks silently narrows the corpus, which is the exact failure the loader already refuses when it fails a whole load rather than skipping one bad file. Staleness is a property of the gold rather than of the backend, so excluding the task punishes every backend identically and hides that the suite is decaying, which is information the reader needs more than a marginally cleaner number. It would make results non-comparable over time, because the same suite would score a different set of tasks every month as items crossed the 183-day line, and a movement between two runs could then be the backend or could be the calendar with no way to tell. And counting with a flag preserves the option that dropping destroys: from one run a report can compute both an all-tasks figure and a fresh-tasks-only figure, whereas from a corpus that dropped stale tasks at load the first can never be recovered without re-buying the research.

**The rule now lives in exactly one place**, [`../bench/task-format.md`](../bench/task-format.md), and this document and every downstream item reference it rather than restating it.

**Wrong, or at least too optimistic: "adopt the shell."** promptfoo was evaluated against the real package on 27 July 2026 before anything was built on it, as the brief required. Three of the four claims hold. The fourth does not: `promptfoo eval --resume` identifies the completed set correctly and then re-executes the whole matrix anyway, which on a benchmark whose cells cost $1 to $7 each means one resume re-buys everything already paid for. It also has no budget gate, and cannot have one at its extension points, because a provider and an assertion are both called per cell after the batch has started.

So the adoption is split where the evidence splits it. The scorer contract is adopted exactly: every scorer returns `{ pass, score, reason }`, which is promptfoo's `GradingResult`, so a `javascript` assertion is a two-line wrapper. The execution shell is built here, because the two missing pieces are the control loop. The measurement, the reproduction and the reasoning are in [`../bench/run-harness.md`](../bench/run-harness.md).

## Implementation

TypeScript in this repo, typechecked by `tsgo`, for one reason that outweighs the others: `corroborate.ts`, `evidence.ts` and `citations.ts` already export 34 of the primitives the scorer needs, all already tested. Adopting a Python harness means a second implementation of independent-domain counting and source classification, and two implementations of a rule eventually disagree about what the rule is.

Rust or Go would buy nothing here. The workload is HTTP-bound, not CPU-bound.

Shape:

```
bench/
  tasks/*.yaml        one file per task: question, gold facts, required terms,
                      known dissent URLs, as-of date, category
  src/score/*.ts      one module per category, pure functions over a report
  src/run/*.ts        matrix of task x backend x repetition; plan, refuse,
                      execute, resume. Built, not adopted; see the amendment
  results/*.jsonl     one line per cell, raw, so scoring can be re-run
                      without re-running the research
```

Separating the run from the scoring matters more than it looks: research is the expensive part and scoring is the part that will change as the metrics are refined. Storing raw reports means a metric can be added later and applied retrospectively to runs already paid for.

## The honest limits

- **Task authoring is the bottleneck and the weak point.** Ten categories at ten tasks each is a hundred hand-built gold sets. A thin suite will produce confident rankings from too little evidence, which is the exact failure the product is against.
- **Gold sets rot.** A revenue figure is correct until the next filing. Every task carries an as-of date and a re-verification date, and a task whose gold has not been re-checked inside six months is flagged stale. **Corrected 27 July 2026: it is still scored.** See the amendment below; [`../bench/task-format.md`](../bench/task-format.md) is the one place that rule is written.
- **Token containment is not entailment.** A page can contain "28.6%" while saying something else about it entirely. This is a deliberate trade: the check is weaker than a model's judgement and it is exact, repeatable and free, which for a regression suite is the better bargain. Reported as what it is, never as claim verification.
