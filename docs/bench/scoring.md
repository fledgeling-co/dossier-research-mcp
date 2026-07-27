# Calibration, refusal correctness and recency

Three of the benchmark's scored dimensions, in `bench/src/score/`. Every function here is pure, synchronous, and takes a report's text plus a loaded task. Nothing reads a file, nothing calls a network, and nothing calls a model, because the rule governing the whole benchmark is that every score is computed by code from a gold set fixed before the run.

The task format these read is [`task-format.md`](task-format.md). The design is [`docs/plan/benchmark.md`](../plan/benchmark.md).

## Calibration

Accuracy tells you how often a backend is right. It cannot tell you whether the backend knows when it is right, and that is the difference between a report you can act on selectively and one you have to verify from the top.

The design's own example: a backend right 60% of the time that says High every time is worse than one right 55% whose Highs are right 90%. Nothing else in the suite can see that. Calibration can, and it is the reliability term below that carries it.

### What counts as a stated confidence

Only the forms this product actually asks a backend to produce. `src/research/prompt.ts` requires a confidence qualifier on every non-trivial claim, an executive summary whose bullets are led by `(High Confidence)`, and a `<CONFIDENCE:LOW>` tag for a weakly supported but load-bearing estimate. `src/gemini/agents.ts` says the same to the Managed Agents surface, and the free local loop writes `**Confidence: N/A**` when it found nothing at all.

So there are four recognised forms and deliberately no fifth:

| Form | Example |
|---|---|
| Bullet leader | `- **(High Confidence)** The filing states 1.2 billion.` |
| Epistemic-bounding tag | `<CONFIDENCE:LOW>The 2027 figure is an estimate.</CONFIDENCE:LOW>` |
| Labelled | `Confidence: Medium`, and `Confidence: N/A` for an abstention |
| Trailing label | `Medium Confidence: the vendor has not published a figure.` |

Inventing a fifth form would score a shape nobody was asked to produce, and would make a backend look uncalibrated for obeying its brief. The trailing-label form is read only at the head of a line, optionally behind a bullet or bold markers, because unanchored it fires on ordinary prose: "the authors express high confidence: the method is sound" is not a confidence qualifier, and reading it as one invents a High marker that then governs the rest of the sentence.

**What a marker governs.** A tag governs exactly its own contents, because a delimiter the author wrote beats anything inferred. Any other marker governs forward from its end to whichever comes first: the start of the next marker, or the end of its paragraph. Both boundaries are structural, so the rule fits in a sentence and an argument about a pairing is an argument about the text rather than about a constant somebody tuned.

**And backward when there is nothing forward.** The prompt specifies a leading qualifier for executive-summary bullets and asks for one on every non-trivial claim elsewhere without saying where it goes. The natural shape in prose is trailing: `Revenue reached 1.2 billion. (High Confidence)`. Read forward only, that marker governs an empty span, the claim is never paired, and the report is scored over whichever half of it happened to lead. A marker whose forward span holds no letters or digits therefore reads back to the start of its paragraph, stopping at whatever the previous marker already governs so one sentence is never counted twice.

### How a confidence is paired with an answer

This is the part worth understanding before you write a task file, because it decides whether your task can measure anything.

An answer pairs with a marker when the marker's span **mentions the answer's subject**. The subject is the answer's `label` where it has one, and its written value plus any `aliases` where it does not.

The label is the primary key on purpose. Pairing on the value can only ever match a report that already got the answer right, so a confidently wrong claim, which is the single thing this metric exists to catch, would never be paired and the backend would never be charged for it. The label is the subject and survives a wrong answer.

**Give every answer a label.** When one has none, the result carries `pairedByValueOnly: true` and a note saying exactly what the fallback cannot see, rather than degrading quietly.

Where a report discusses one answer at two different levels, the higher is taken, since that is the claim a reader acts on, and the answer is counted in `ambiguousPairings` so the ambiguity is visible rather than averaged away.

### Whether the answer was recovered is an input

`scoreCalibration(report, task, recovered)` takes `recovered` as a plain record keyed by gold-fact id. Deciding recovery means knowing that `1.2 billion`, `1,200,000,000` and `1.2B` are one number, that a unit changes the answer, and how names normalise under Unicode. That is the accuracy scorer's whole job, and two implementations of one rule eventually disagree about what the rule is.

An id missing from that record is counted `unresolved` and excluded. A sibling scorer failing to report must never turn into a penalty against the backend under test.

### Unmeasurable is not zero

A Brier score of zero is a **perfect** score. Returning zero for a report that stated no confidence would report the worst case as the best, so an unmeasurable result carries no Brier score at all and no caller can read one.

There are three reasons, and they are different findings:

| Reason | What happened | What to do |
|---|---|---|
| `no-markers` | The report stated no confidence anywhere. | A finding about the backend. Report it. |
| `markers-present-but-unpaired` | It stated confidence, but never about anything the gold set asked for. | Usually a relevance failure showing up here. |
| `no-recovery-input` | It stated confidence about the right answers and nothing said whether they were right. | A pipeline gap, not a backend result. |

A task with no gold facts, which is every refusal task, returns `not-applicable`. That agrees with `applicableMetrics.calibration` from the loader rather than re-deriving eligibility.

### The numbers it returns

`brier` is the mean squared error between stated confidence and outcome, so lower is better and zero is perfect. Underneath it is the Murphy decomposition, `reliability - resolution + uncertainty`:

| Term | What it measures |
|---|---|
| `reliability` | How far each level's stated probability sits from what that level actually delivered. The term that answers the design's example, and the one to report. |
| `resolution` | How much the levels actually separated outcomes. A backend that says High to everything has zero resolution however accurate it is. |
| `uncertainty` | The base rate's own variance, which no backend controls. |

`bins` is the reliability table: per level, how many answers, what probability was assigned, and what share was actually recovered.

**Never read the Brier score without its coverage.** `scoredAnswers`, `goldFacts` and `coverage` say how much of the task the score covers, and silence is otherwise free: a backend that states a confidence only about the answers it got right scores near-perfectly over a sample it chose for itself. On a three-answer task with two wrong, saying nothing about the two is worth roughly fifty times on the headline number. A reporter that prints the Brier score without the coverage beside it is publishing a number the backend selected.

### The probability map, which you may disagree with

A Brier score is meaningless without the map from a stated word to a probability. The default is High 0.9, Medium 0.6, Low 0.3, exported as `DEFAULT_CONFIDENCE_PROBABILITY`.

Those numbers are a convention, not a measurement. Ordering between backends survives any monotonic map; the values do not. So the map travels on every result and `scoreCalibration` takes a replacement, which means a stored raw cell can be re-scored against a different map without re-buying the research. A replacement is validated: a value outside zero to one is refused with a `TypeError` rather than producing a confident out-of-range score, since re-scoring later is precisely where a typo in the map would go unnoticed.

### Abstentions

`Confidence: N/A` is a refusal to state a confidence, not a low one. It is counted separately and never enters the score. The 2026 methodology literature is explicit that abstention handling is not interchangeable preprocessing, so this is declared rather than folded in.

## Refusal correctness

Two families where the right answer is not an answer. **False premise**: the question presupposes an event that did not occur, and the report must not assert it. **No public footprint**: a real but genuinely undocumented subject, and the report must say so.

These are the only categories in the suite where a long, confident, fluent report is the worst possible outcome. Every other metric rewards saying more. Without this pair the benchmark quietly selects for confident verbosity.

**A backend that correctly pushes back scores full marks even if it says nothing else useful.** That is the point, not a rounding of it.

### Three outcomes, not two

| Outcome | What it means | Score |
|---|---|---|
| `refused` | Every paragraph raising the fabrication also pushes back in that paragraph, or on the obscure-entity arm the report says it found nothing. | 1.0 |
| `unengaged` | Neither acknowledgement nor fabricated wording, or the report is empty. | 0.5 |
| `asserted` | At least one paragraph raises the fabrication with no pushback in it, or an obscure-entity answer never says it found nothing. | 0.0 |

The middle one exists because the two rules in play disagree. Checking only that a fabricated name is absent cannot tell a report that asserted the fabrication from one that corrected it, since both contain the name, which is why the task format requires acknowledgement wording on both arms. But the design's literal rule is "the report must not assert it", under which a report that never mentioned the subject passes. Rather than pick, the raw outcome is returned beside the number, so a reader who wants the stricter rule can recompute from a stored cell without re-running anything.

The middle outcome also covers an **empty** report. An empty report is a harness or provider failure rather than backend behaviour, and scoring it as an assertion would make a provider error indistinguishable from a confident fabricated answer, which is the worst possible confusion in the one category that exists to catch confident answers.

### The decision is per paragraph, not per document

This is the part that had to be got right. Acknowledgement wording *somewhere* in a long report does not excuse a paragraph that states the fabrication as fact. A report that opens with a flat assertion, complete with a date, a venue and a clause number, and then hedges two paragraphs later about something else, contains an acknowledgement term and contains the fabrication, and a whole-document check scored it a clean refusal at full marks.

So the outcome is decided on `unacknowledgedFabricationParagraphs`: the number of paragraphs that raise a fabricated term with no acknowledgement in them. Zero of those is a refusal; one or more is an assertion. A paragraph is the finest grain the task format supports, because all it records is wording.

`fabricationParagraphs` and `acknowledgedNearFabrication` travel alongside so a reader can see the shape rather than only the verdict.

The honest limit: a sentence that both asserts and hedges, `the Accord was signed in 2019 and there is no evidence it has since been amended`, reads as a refusal here. Distinguishing it needs stance, and stance needs a model, which the benchmark's governing rule forbids.

### Overconfidence

`overconfident` is true when the report failed to refuse **and** stated High confidence about the subject. This is DeepTRACE's published Overconfident Answer dimension, adopted rather than invented, per the design's amendment of 27 July 2026. A wrong answer given tentatively and the same answer given confidently are not the same product failure.

"About the subject" is enforced on the false-premise arm: the High marker's span has to mention a fabricated term, so a report that never engaged and stated High about an unrelated aside is not flagged. The no-public-footprint arm records no subject wording to key on, so any High marker counts there, and that limit is stated rather than hidden.

`reportChars`, `markerCount` and `abstentions` travel on the result so a reporter can show verbosity beside outcome without re-parsing the report. `markerCount` means the same thing in both scorers: every marker found, abstentions included.

## Recency

`docs/plan/benchmark.md` lists recency as a scored dimension and says to weight by source type "using the existing rule that a standard from 2019 is current while a benchmark from 2019 is not".

That rule did not exist. `HORIZONS` in `src/research/evidence.ts` is keyed by source type alone, so a 2019 W3C recommendation and a 2019 leaderboard land in the same bucket and grade identically. BENCH-01 verified it; BENCH-06 built it.

### Durability is a second axis, orthogonal to source type

What makes a document age is not who published it but whether it describes something that changes. A specification is current until something supersedes it. A benchmark result, a price list, a changelog or a leaderboard is a measurement of a moment, and six months later it describes a world that has moved.

`classifyDurability(url)` returns `durable`, `perishable` or `unknown`, each with a basis string so a wrong call is arguable rather than opaque.

| Verdict | What it catches |
|---|---|
| `durable` | Standards bodies, legislatures and courts by host, plus paths naming a standard, specification or statute wherever they are hosted. |
| `perishable` | Paths naming a leaderboard, benchmark, price list, changelog, release or status page, plus hosts that exist to publish a moving number. |
| `unknown` | Everything else, which is the common and honest answer. |

Perishable is checked first, and the order is the interesting half: a benchmark result published by a standards body is still a benchmark result. The host says who wrote it, the path says what it is.

The same argument cuts the other way, and cost two rounds to get right. A standards body publishes news, blog posts and press releases beside its specifications, so a blog or press path on a durable host is demoted to `unknown` rather than counting as durable. And a path segment that merely *looks* like a document type is not enough: `tr` was in the durable list for `w3.org/TR/` until it was noticed that `/tr/` is the ordinary Turkish locale segment, which was grading 2019 news articles current in 2026. That page is reached by host anyway, which is the narrower and correct route.

### What the horizons do

`BENCH_SOURCE_HORIZONS` restates the product's per-type table, then durability adjusts it in one direction only:

A `durable` source takes the wider of the type horizon and a floor of ten years to ageing, fifteen to stale. Durability may only ever widen, because a standard does not rot on a calendar and must never be made to look staler than the type rule already said.

A `perishable` source takes the tighter of the type horizon and a ceiling of three months to ageing, six to stale. Six months is the number the product already uses for news, for the same reason.

An `unknown` source keeps the type horizon exactly as it is, so it grades precisely as the product grades it. That is load-bearing, and it is locked by a parity test driving `assessStaleness` and this file side by side across every horizon boundary. If the product ever changes its numbers, the benchmark fails rather than quietly measuring against an old rule.

One narrow, deliberate divergence from the product. `assessStaleness` rounds the age to whole days before asking whether the source is dated after the as-of date, and `Math.round(-0.4)` is negative zero, which is not less than zero: a source stamped up to twelve hours *after* the as-of date falls through that guard and is counted current. The benchmark branches on the raw difference instead, so the same source is `after-horizon` and stays out of the numerator. The product still has the hole; fixing it there changes what `research_evidence` prints and is named as a follow-up rather than done here.

### What the product does not do

`assessStaleness` is unchanged. Adding the durability axis to it would change what `research_evidence` prints for every user, which is a product decision rather than a benchmark item's to take. The follow-up is named here rather than done by side effect.

### The report-level figure

`scoreRecency(sources, asOf)` grades every source and returns the counts per freshness plus `freshShare` over the **dated** sources only.

An undated source is carried as its own number and never counted as current: a recency figure that quietly counts undated as fresh rewards a backend for citing pages that carry no date. A source dated after the as-of date is a transcription error or a back-dated source rather than a fresh one, so it is excluded too. An empty source list returns `not-applicable`, because an empty set is not a fresh one, and a set where nothing could be dated returns `unmeasurable`.

An unreadable **as-of** date throws. It is the caller's argument rather than the corpus's data, and reporting it per source produced the worst possible message: every source blamed for a missing date it plainly had, which sends whoever is debugging it to the gold set instead of to the one broken line. The loader already takes this position on an invalid reference date, and this matches it.

## Using them

```ts
import { scoreCalibration, scoreRefusal, scoreRecency } from '../../bench/src/score/index.js';

const calibration = scoreCalibration(report, task, { revenue: true, headcount: false });
const refusal = scoreRefusal(report, task);
const recency = scoreRecency(citedSources, task.asOf);
```

Every one of the three returns a discriminated union on `status`, so a caller has to handle the not-applicable and unmeasurable cases rather than reading a number that was never computed.
