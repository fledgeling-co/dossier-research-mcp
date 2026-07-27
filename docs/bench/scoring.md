# Accuracy, relevance, calibration, refusal correctness and recency

Five of the benchmark's scored dimensions, in `bench/src/score/`. Every function here is pure, synchronous, and takes a report's text plus a loaded task. Nothing reads a file, nothing calls a network, and nothing calls a model, because the rule governing the whole benchmark is that every score is computed by code from a gold set fixed before the run.

The task format these read is [`task-format.md`](task-format.md). The design is [`docs/plan/benchmark.md`](../plan/benchmark.md). The source-quality dimension, which grades the sources themselves rather than the report, is next door in [`source-quality.md`](source-quality.md).

## Accuracy

Did the report actually state the answers the gold set records? The score is the share recovered.

Two failure modes make this harder than a string search, and both are silent.

### Number formats are where the false negatives live

`1.2 billion`, `1,200,000,000` and `1.2B` are one figure. A scorer that knows one spelling of it measures prose style rather than research quality, and reports every backend as worse than it is with nothing in the output to say why. So the reader handles comma grouping, plain and decimal forms, exponents, currency symbols and codes before the number, scale words and suffixes after it, and the ambiguity between them.

**Scaling shifts a decimal point in a string rather than multiplying.** `1.005 * 1e6` is `1004999.9999999999`, `0.267 * 1e9` is `267000000.00000003`, and either would fail an exact tolerance for reasons having nothing to do with research. Those cases were found by sweeping real two- and three-decimal figures, not guessed: the first draft of the test asserted `1.1 * 1e6` was inexact, and it is not.

**Nothing here emits exponential notation.** `String(1e21)` and `(1e21).toFixed(0)` are both `1e+21`, and a benchmark that prints that has misreported its own gold set.

**An ambiguous suffix is read every plausible way.** `450m` is 450 million and it is 450 metres. Both readings are produced and a fact matches if either fits, because the expensive error here is the false negative and an ambiguity the report genuinely left open should not be resolved against the backend.

### A right figure with the wrong unit scores zero

Not partial credit. The unit is why the task format requires one on every numeric answer.

The rule is mechanical, and it is the whole of `units.ts`:

- Units are **canonicalised, never converted**. Kilometres do not satisfy a gold in metres; conversion would put arithmetic inside a match test.
- Percent, percentage points and basis points are three units, and two currencies are two units. Those are the confusions being caught, so they can never canonicalise together. Lookup is longest-form-first, which is why `percentage points` is never read as `percentage`.
- A unit the lexicon has never heard of is **its own class**, so an author unit like `questions` compares equal to itself and unequal to everything else.
- A gold unit may carry its own scale word. `1.2` with unit `USD billions` and `$1.2bn` in a report are one fact.

**A unit is read before the figure as well as after it.** A report writes "the CVSS v3.1 base score was 8.8", never "8.8 CVSS v3.1 base score". Looking only forward made every such figure read as unit-unstated, which turned the wrong-unit rule off for exactly the answers whose unit is most worth checking.

**Unstated is not wrong.** A figure with no recognised unit written beside it still counts, and is reported as `unstated` rather than as equal to a stated one. The corpus really does carry units like `CVSS v3.1 base score` that no report will ever write out, and refusing those would be a false negative in the category where false negatives are most expensive. A figure carrying a *recognised different* unit is refused outright.

**A different member of the same family is a wrong unit, not an absent one.** `CVSS v3.1 base score` and `CVSS v4.0 base score` are two units of one family, and neither can live in a global lexicon. So a multi-word author unit contributes its first token as a family name: if a report names the family near the figure without naming *this* member of it, the figure is quoting a different unit and does not recover. Without this, a report stating the v4.0 score was credited with the v3.1 gold, which is the wrong-unit rule failing against a real corpus task rather than a fixture.

A single-token unit has no family to be wrong about, so a gold of `questions` against a report writing `303 answers` stays an unstated unit rather than becoming a wrong one.

### Citations are not prose

Matching runs over the report's prose with every citation form stripped: markdown link destinations, images, CommonMark autolinks, reference definitions, bare URLs and `cite` tags. That is every form `extractCitedUrls` recognises, and a test reads them out of that module rather than trusting this list to stay in step.

Link *text* is kept, because "as Reuters reported" is prose the model wrote. Text that is itself a bare hostname is dropped with its URL, because `[arxiv.org](https://arxiv.org/...)` is this repo's own citation style and the visible half is part of the citation.

A **numeric label** goes too. The server rewrites stored citations into a bracketed number followed by a parenthesised link, so a bare `1` left in the prose would let a gold value of 1 be recovered from a citation marker. Capped at three digits, so a link whose text is a real figure stays prose.

Characters whose *numeric meaning* Unicode normalisation would change are blanked before any of this: NFKC turns a superscript two into a plain `2`, so `10` squared would otherwise read as `102`, and circled digits and vulgar fractions do the same.

Without this, a backend that pasted a URL containing the figure would score for reasoning it never did.

### A denied figure is still a figure

"Revenue was not 1.2 billion" contains `1.2 billion`. A value found only inside a denial is not recovered; one plain occurrence anywhere is enough.

The scope is the clause containing the match, bounded by a contrast word and by a ten-word window, against a fixed cue list. `no` on its own is deliberately absent: "no fewer than 303 questions" asserts 303, and catching it would invent a false negative.

This is a cue list, not comprehension. It cannot see "the claim that revenue reached 1.2 billion is disputed", and the result says so in its notes rather than implying it read the sentence. `ignoreNegation` re-runs a corpus with the rule off, so its effect is measured rather than argued about.

**A date states no number.** `2026-07-01` holds a `07`, and because an unstated unit is compatible with any gold unit, a gold of seven would otherwise be recovered from a publication date. Whole date shapes are blanked before scanning, length-preserving so every other offset survives. Whole shapes only: `2026-07-27` and `50-60%` look identical at the hyphen, and both numbers in a range are real.

### Dates

The accepted written forms are enumerated rather than handed to `Date.parse`, which accepts a bare year as a date and differs between engines. `2026-07-08`, `2026/07/08`, `8 July 2026`, `July 8, 2026`, three-letter months and ordinal suffixes all match. A month and year with no day does not: naming the month is not finding the day.

`03/04/2026` is genuinely ambiguous, so both readings are produced and either may match, with the ambiguity carried on the result. Guessing a locale would score one convention's reports better than the other's.

### Tolerance

| Arm | Test |
|---|---|
| `exact` | strict equality. Safe only because both sides are parsed decimal-safely; an earlier draft allowed a `1e-12` relative guard "for float noise", and that is a tolerance in disguise, accepting a reported `0` for a gold of `1e-13` |
| `absolute` | `abs(reported - gold) <= value` |
| `relative` | `abs(reported - gold) <= fraction * abs(gold)`. At a gold of zero this has no width and behaves as equality, which is noted on the result rather than left to be discovered |
| `significantFigures` | both sides rounded to the stated digits, then compared |

### What it returns

`not-applicable` when the task records no gold facts, never a zero: a refusal task carries no answers, and a zero in that denominator reports every backend as worse than it is. Otherwise the share recovered, a per-answer verdict with the reason in words, and the **recovery record keyed by answer id** that `scoreCalibration` takes as its input. That record is the reason answer ids are required by the task format.

Staleness is not consulted. A stale task loads, is scored, and is counted as stale by the run harness, which prints the count before the run.

## Relevance

Is the report about the right subject at all? The naive version of this needs a model to read it, and the design forbids one, so the measurement moves to authoring time: the author records the required terms a competent answer cannot avoid and the drift terms that mean it wandered.

```
coverage   = required terms present / required terms recorded
drift      = drift terms present / drift terms recorded     (zero when none are recorded)
score      = clamp(coverage - weight * drift, 0, 1)          (weight 1 by default)
```

Each term counts once whether it appears once or forty times. `coverage` and `drift` are both returned beside the score, because a collapsed number hides what its components say and a reader who disagrees with the weight can recompute without re-running anything.

**It is crude on purpose and must stay crude.** Its whole job is to separate an answer about the right subject from one that is not; whether the answer is correct is accuracy's question. Upgrading this into something that needs a model would give up the property that makes the benchmark re-runnable for free.

Two smaller rules. Terms match over prose rather than citations, or a required term like `containerd` would score coverage for every URL a report cited. And **negation is deliberately not applied here**, unlike in accuracy: a report saying "this is not about Kubernetes" has raised Kubernetes, and polarity changes whether an *answer* is right rather than whether a subject came up.

A term is matched literally, on word boundaries. A report using a synonym the author did not record scores nothing for it, and the result says so rather than hiding it. `not-applicable` when the task records no required terms.


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

## Deferred, and recorded rather than hidden

**Two numeric implementations exist and should become one.** The due-weight scorer needs the same decimal-safe shifting and the same tolerance comparison, and reached both independently while this item was in flight; its own source says the same thing from the other side. Neither could safely edit the other's file while both were unmerged, so the duplication is deliberate and temporary. They agree on `exact`, on the four tolerance arms and on masking whole date shapes, which is the reassuring half; they differ on which magnitude words they accept, which is the half that will drift. Unify now that both have merged.

**Backward negation only.** A cue is looked for before the figure, never after, so "8.8, not 7.2" correctly leaves 8.8 asserted while "8.8 is not the assigned score" is missed. Scanning forward as well would fix the second and break the first, and the first is the commoner shape. Recorded as a known limit rather than traded silently.

**A wrong unit stated before a figure, whose family cannot be named.** The family rule needs a multi-word author unit. A single-token unit stated wrongly before a figure still reads as unstated.

## Using them

```ts
import {
  scoreAccuracy,
  scoreRelevance,
  scoreCalibration,
  scoreRefusal,
  scoreRecency,
} from '../../bench/src/score/index.js';

const accuracy = scoreAccuracy(report, task);
const relevance = scoreRelevance(report, task);
const calibration = scoreCalibration(report, task, accuracy.recovery);
const refusal = scoreRefusal(report, task);
const recency = scoreRecency(citedSources, task.asOf);
```

Accuracy runs before calibration, because calibration cannot grade a stated confidence without knowing whether the answer it governs was right, and it deliberately does not work that out for itself.

Every one of the five returns a discriminated union on `status`, so a caller has to handle the not-applicable and unmeasurable cases rather than reading a number that was never computed.
