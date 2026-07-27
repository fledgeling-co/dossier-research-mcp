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
- **Registry existence.** A DOI resolves in Crossref, an arXiv id in the arXiv API, a PMID in NCBI E-utilities, an ISBN in OpenLibrary, a CVE in the NVD. **This is programmatic hallucination detection**, and it is the sharpest instrument in the whole benchmark: a fabricated academic citation is the canonical failure of this product category, and it can be caught exactly, with no judgement at all.
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

All existing code. `classifySource` for the official / academic / journalism / community mix, `registrableDomain` for independent-domain counting, `countsAsCorroboration` for the rule that agreement between backends is not corroboration.

One addition: **syndication detection**, by shingled hashing of fetched page text. Four domains carrying the same wire story are one source wearing four hats, and independent-domain counting alone cannot see it.

### 8. Recency

Parse publication dates from sources, compare against the task's as-of horizon, weight by source type using the existing rule that a standard from 2019 is current while a benchmark from 2019 is not.

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

## Implementation

TypeScript in this repo, typechecked by `tsgo`, for one reason that outweighs the others: `corroborate.ts`, `evidence.ts` and `citations.ts` already export 34 of the primitives the scorer needs, all already tested. Adopting a Python harness means a second implementation of independent-domain counting and source classification, and two implementations of a rule eventually disagree about what the rule is.

Rust or Go would buy nothing here. The workload is HTTP-bound, not CPU-bound.

Shape:

```
bench/
  tasks/*.yaml        one file per task: question, gold facts, required terms,
                      known dissent URLs, as-of date, category
  src/score/*.ts      one module per category, pure functions over a report
  src/run.ts          matrix of task x backend x repetition
  results/*.jsonl     one line per cell, raw, so scoring can be re-run
                      without re-running the research
```

Separating the run from the scoring matters more than it looks: research is the expensive part and scoring is the part that will change as the metrics are refined. Storing raw reports means a metric can be added later and applied retrospectively to runs already paid for.

## The honest limits

- **Task authoring is the bottleneck and the weak point.** Ten categories at ten tasks each is a hundred hand-built gold sets. A thin suite will produce confident rankings from too little evidence, which is the exact failure the product is against.
- **Gold sets rot.** A revenue figure is correct until the next filing. Every task carries an as-of date and a re-verification date, and a task whose gold has not been re-checked inside six months is reported as stale rather than scored.
- **Token containment is not entailment.** A page can contain "28.6%" while saying something else about it entirely. This is a deliberate trade: the check is weaker than a model's judgement and it is exact, repeatable and free, which for a regression suite is the better bargain. Reported as what it is, never as claim verification.
